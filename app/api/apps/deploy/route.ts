import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/auth";
import { normalizeAppConfig } from "@/lib/config-normalizer";
import type { Prisma } from "@prisma/client";
import { apiSuccess, apiError, withErrorBoundary, RouteHandler } from "@/lib/api-response";
import type { AppConfig } from "@/types/config";

// ---------------------------------------------------------------------------
// POST /api/apps/deploy
// ---------------------------------------------------------------------------

const handler: RouteHandler = async (req) => {
  const authResult = requireAuth(req);
  if ("response" in authResult) return authResult.response;
  const { ctx } = authResult;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return apiError(
      "Request body must be valid JSON. Even an empty config object {} is accepted.",
      400
    );
  }

  const { config, warnings } = normalizeAppConfig(rawBody);

  const userExists = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { id: true },
  });

  if (!userExists) {
    return apiError("User not found. Register first via POST /api/auth/register.", 404);
  }

  const app = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const createdApp = await tx.app.create({
      data: {
        name: config.name,
        userId: ctx.userId,
        config: config as unknown as Record<string, unknown>,
      },
    });

    if (config.collections.length > 0) {
      await tx.collection.createMany({
        data: config.collections.map((c) => ({ name: c.name, appId: createdApp.id })),
        skipDuplicates: true,
      });
    }

    return createdApp;
  });

  const appWithCollections = await prisma.app.findUnique({
    where: { id: app.id },
    include: {
      collections: { select: { id: true, name: true, createdAt: true }, orderBy: { createdAt: "asc" } },
    },
  });

  return apiSuccess(
    {
      app: {
        id: appWithCollections!.id,
        name: appWithCollections!.name,
        config: appWithCollections!.config as AppConfig,
        collections: appWithCollections!.collections,
        createdAt: appWithCollections!.createdAt,
      },
      normalizationWarnings: warnings,
      message:
        warnings.length > 0
          ? "App deployed with normalization adjustments. Review warnings."
          : "App deployed successfully.",
    },
    201
  ) as NextResponse;
};

export const POST = withErrorBoundary(handler);
