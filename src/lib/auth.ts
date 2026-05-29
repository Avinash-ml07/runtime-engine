import jwt from "jsonwebtoken";
import { apiError } from "./api-response";
import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JwtPayload {
  userId: string;
  email: string;
  iat?: number;
  exp?: number;
}

// ---------------------------------------------------------------------------
// Token utilities
// ---------------------------------------------------------------------------

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? "7d";

if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET environment variable is not set. " +
      "Add it to your .env file before starting the server."
  );
}

export function signToken(payload: Omit<JwtPayload, "iat" | "exp">): string {
  return jwt.sign(payload, JWT_SECRET as string, {
    expiresIn: JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET as string) as JwtPayload;
}

// ---------------------------------------------------------------------------
// Request authentication
//
// Supports two mechanisms (in order of priority):
//   1. Authorization: Bearer <token>   — standard JWT flow
//   2. x-user-id header                — mock/simulation context for demo
// ---------------------------------------------------------------------------

export interface AuthContext {
  userId: string;
  email: string;
  isMock: boolean;
}

export function extractAuthContext(req: Request): AuthContext | null {
  // ── Path 1: Bearer JWT ──────────────────────────────────────────────────
  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    try {
      const payload = verifyToken(token);
      return { userId: payload.userId, email: payload.email, isMock: false };
    } catch {
      return null;
    }
  }

  // ── Path 2: Mock x-user-id header (demo / simulation only) ─────────────
  const mockUserId = req.headers.get("x-user-id") ?? "";
  if (mockUserId.trim()) {
    return { userId: mockUserId.trim(), email: "mock@demo.local", isMock: true };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Guard helper — returns 401 response when auth is missing
// ---------------------------------------------------------------------------

export function requireAuth(
  req: Request
): { ctx: AuthContext } | { response: NextResponse } {
  const ctx = extractAuthContext(req);
  if (!ctx) {
    return {
      response: apiError(
        "Authentication required. Provide a Bearer token or x-user-id header.",
        401
      ),
    };
  }
  return { ctx };
}
