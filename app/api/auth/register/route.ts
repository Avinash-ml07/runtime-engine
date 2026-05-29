import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { signToken } from "@/lib/auth";
import { apiSuccess, apiError, withErrorBoundary, RouteHandler } from "@/lib/api-response";

const RegisterSchema = z.object({
  email: z
    .string({ required_error: "Email is required" })
    .email("Must be a valid email address")
    .toLowerCase()
    .trim(),
  password: z
    .string({ required_error: "Password is required" })
    .min(8, "Password must be at least 8 characters"),
});

const handler: RouteHandler = async (req) => {
  if (req.method !== "POST") return apiError("Method not allowed", 405);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Request body must be valid JSON", 400);
  }

  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) return apiError("Validation failed", 422, parsed.error.flatten());

  const { email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return apiError("A user with this email already exists", 409);

  const hashedPassword = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({ data: { email, password: hashedPassword } });
  const token = signToken({ userId: user.id, email: user.email });

  return apiSuccess(
    { token, user: { id: user.id, email: user.email, createdAt: user.createdAt } },
    201
  ) as NextResponse;
};

export const POST = withErrorBoundary(handler);
