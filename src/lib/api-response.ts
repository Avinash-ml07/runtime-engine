import { NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  PrismaClientKnownRequestError,
  PrismaClientUnknownRequestError,
  PrismaClientInitializationError,
  PrismaClientValidationError,
} from "@prisma/client/runtime/library";

// ---------------------------------------------------------------------------
// Canonical response envelope
// ---------------------------------------------------------------------------

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Response factories
// ---------------------------------------------------------------------------

export function apiSuccess<T>(
  data: T,
  status: number = 200
): NextResponse<ApiResponse<T>> {
  return NextResponse.json({ success: true, data }, { status });
}

export function apiError(
  message: string,
  status: number = 400,
  details?: unknown
): NextResponse<ApiResponse<never>> {
  return NextResponse.json(
    {
      success: false,
      error: message,
      ...(details !== undefined && { details }),
    },
    { status }
  );
}

// ---------------------------------------------------------------------------
// Route handler type compatible with Next.js App Router
// ---------------------------------------------------------------------------

export type RouteHandler = (
  req: Request,
  ctx: { params: Record<string, string> }
) => Promise<NextResponse>;

// ---------------------------------------------------------------------------
// Global error boundary — wraps any route handler
// Never lets raw Prisma/DB exceptions leak to the client.
// ---------------------------------------------------------------------------

export function withErrorBoundary(handler: RouteHandler): RouteHandler {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err: unknown) {
      // Zod validation failures
      if (err instanceof ZodError) {
        return apiError("Validation failed", 422, err.flatten());
      }

      // Prisma known request errors (e.g. unique constraint, foreign key)
      if (err instanceof PrismaClientKnownRequestError) {
        return handlePrismaKnownError(err);
      }

      // Prisma unknown / connection errors
      if (
        err instanceof PrismaClientUnknownRequestError ||
        err instanceof PrismaClientInitializationError
      ) {
        console.error("[DB] Prisma connection/unknown error:", err);
        return apiError("Database unavailable. Please try again later.", 503);
      }

      // Prisma validation error (bad data shape sent to Prisma itself)
      if (err instanceof PrismaClientValidationError) {
        console.error("[DB] Prisma validation error:", (err as Error).message);
        return apiError("Internal data error. Please check your input.", 400);
      }

      // Generic / unexpected errors — log full trace server-side, expose nothing
      console.error("[UNHANDLED]", err);
      return apiError("An unexpected error occurred.", 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Prisma known error mapper
// ---------------------------------------------------------------------------

function handlePrismaKnownError(
  err: PrismaClientKnownRequestError
): NextResponse<ApiResponse<never>> {
  switch (err.code) {
    case "P2002":
      return apiError(
        `A record with that value already exists. (field: ${
          Array.isArray(err.meta?.target)
            ? (err.meta?.target as string[]).join(", ")
            : "unknown"
        })`,
        409
      );
    case "P2025":
      return apiError("The requested record was not found.", 404);
    case "P2003":
      return apiError("Referenced resource does not exist.", 400);
    case "P2014":
      return apiError("Required relation data is missing.", 400);
    default:
      console.error(`[DB] Prisma error ${err.code}:`, err.message);
      return apiError("A database error occurred.", 500);
  }
}
