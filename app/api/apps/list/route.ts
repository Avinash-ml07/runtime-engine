import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/auth";
import { apiSuccess, withErrorBoundary, RouteHandler } from "@/lib/api-response";
import type { AppConfig } from "@/types/config";

const handler: RouteHandler = async (req) => {
  const authResult = requireAuth(req);
  if ("response" in authResult) return authResult.response;
  const { ctx } = authResult;

  const apps = await prisma.app.findMany({
    where: { userId: ctx.userId },
    include: {
      collections: { select: { id: true, name: true, createdAt: true }, orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "desc" },
  });

  const payload = apps.map((app: typeof apps[number]) => ({
    id: app.id,
    name: app.name,
    config: app.config as AppConfig,
    collections: app.collections,
    createdAt: app.createdAt,
  }));

  return apiSuccess({ apps: payload, count: payload.length }) as NextResponse;
};

export const GET = withErrorBoundary(handler);
