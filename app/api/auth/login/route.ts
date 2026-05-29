import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { signToken } from "@/lib/auth";
import { apiSuccess, apiError, withErrorBoundary, RouteHandler } from "@/lib/api-response";

const LoginSchema = z.object({
  email: z
    .string({ required_error: "Email is required" })
    .email()
    .toLowerCase()
    .trim(),
  password: z.string({ required_error: "Password is required" }),
});

const handler: RouteHandler = async (req) => {
  if (req.method !== "POST") return apiError("Method not allowed", 405);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Request body must be valid JSON", 400);
  }

  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) return apiError("Validation failed", 422, parsed.error.flatten());

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });
  const passwordMatch = user !== null && (await bcrypt.compare(password, user.password));

  if (!user || !passwordMatch) return apiError("Invalid email or password", 401);

  const token = signToken({ userId: user.id, email: user.email });

  return apiSuccess({
    token,
    user: { id: user.id, email: user.email, createdAt: user.createdAt },
  }) as NextResponse;
};

export const POST = withErrorBoundary(handler);
