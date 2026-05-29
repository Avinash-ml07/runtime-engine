import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/auth";
import { sanitizeRecordData, buildPatchSchema } from "@/lib/schema-factory";
import {
  apiSuccess,
  apiError,
  withErrorBoundary,
  RouteHandler,
} from "@/lib/api-response";
import type { AppConfig, CollectionDefinition, PaginationMeta } from "@/types/config";

// ---------------------------------------------------------------------------
// Route: /api/runtime/[appId]/[collectionName]
// ---------------------------------------------------------------------------

interface RouteContext {
  params: { appId: string; collectionName: string };
}

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const MutationIdSchema = z.object({
  id: z.string().uuid("Record id must be a valid UUID"),
});

// ── Shared guard ──────────────────────────────────────────────────────────────

async function resolveCollection(
  appId: string,
  collectionName: string,
  userId: string
): Promise<
  | { collection: Awaited<ReturnType<typeof prisma.collection.findUnique>> & object; collectionDef: CollectionDefinition }
  | { error: NextResponse }
> {
  const app = await prisma.app.findUnique({
    where: { id: appId },
    select: { userId: true, config: true },
  });

  if (!app) return { error: apiError("App not found", 404) };
  if (app.userId !== userId) return { error: apiError("App not found", 404) };

  const config = app.config as AppConfig;
  const collectionDef = config.collections.find((c) => c.name === collectionName);

  if (!collectionDef) {
    return {
      error: apiError(
        `Collection "${collectionName}" does not exist. Available: ${config.collections.map((c) => c.name).join(", ")}`,
        404
      ),
    };
  }

  const collection = await prisma.collection.findUnique({
    where: { appId_name: { appId, name: collectionName } },
  });

  if (!collection) {
    return {
      error: apiError(
        `Collection "${collectionName}" exists in config but is not registered. Re-deploy to resync.`,
        500
      ),
    };
  }

  return { collection, collectionDef };
}

// ── Parse filter params ───────────────────────────────────────────────────────

function extractFilters(
  urlStr: string,
  collectionDef: CollectionDefinition
): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  const { searchParams } = new URL(urlStr);
  const knownFields = new Set(collectionDef.fields.map((f) => f.name));

  // Use Array.from to avoid downlevelIteration requirement
  Array.from(searchParams.entries()).forEach(([key, value]) => {
    const match = key.match(/^filter\[(.+)\]$/);
    if (match) {
      const fieldName = match[1];
      if (knownFields.has(fieldName)) filters[fieldName] = value;
    }
  });

  return filters;
}

// ── GET ───────────────────────────────────────────────────────────────────────

async function handleGet(
  req: Request,
  appId: string,
  collectionName: string,
  userId: string
): Promise<NextResponse> {
  const resolved = await resolveCollection(appId, collectionName, userId);
  if ("error" in resolved) return resolved.error;
  const { collection, collectionDef } = resolved;

  const { searchParams } = new URL(req.url);
  const queryParsed = ListQuerySchema.safeParse({
    page: searchParams.get("page") ?? 1,
    pageSize: searchParams.get("pageSize") ?? 20,
  });

  const { page, pageSize } = queryParsed.success ? queryParsed.data : { page: 1, pageSize: 20 };
  const skip = (page - 1) * pageSize;
  const filters = extractFilters(req.url, collectionDef);

  const andClauses = Object.entries(filters).map(([field, value]) => ({
    data: { path: [field], equals: value },
  }));

  const where = {
    collectionId: collection.id,
    ...(andClauses.length > 0 ? { AND: andClauses } : {}),
  };

  const [total, records] = await Promise.all([
    prisma.record.count({ where }),
    prisma.record.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: pageSize }),
  ]);

  const pagination: PaginationMeta = {
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
  };

  return apiSuccess({
    records: records.map((r: typeof records[number]) => ({
      id: r.id,
      data: r.data,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    pagination,
    appliedFilters: filters,
  }) as NextResponse;
}

// ── POST ──────────────────────────────────────────────────────────────────────

async function handlePost(
  req: Request,
  appId: string,
  collectionName: string,
  userId: string
): Promise<NextResponse> {
  const resolved = await resolveCollection(appId, collectionName, userId);
  if ("error" in resolved) return resolved.error;
  const { collection, collectionDef } = resolved;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return apiError("Request body must be valid JSON", 400);
  }

  let sanitizedData: Record<string, unknown>;
  try {
    sanitizedData = sanitizeRecordData(collectionDef, rawBody);
  } catch (err) {
    if (err instanceof z.ZodError) return apiError("Record validation failed", 422, err.flatten());
    throw err;
  }

  const record = await prisma.record.create({ data: { collectionId: collection.id, data: sanitizedData } });

  return apiSuccess(
    { id: record.id, data: record.data, createdAt: record.createdAt, updatedAt: record.updatedAt },
    201
  ) as NextResponse;
}

// ── PUT ───────────────────────────────────────────────────────────────────────

async function handlePut(
  req: Request,
  appId: string,
  collectionName: string,
  userId: string
): Promise<NextResponse> {
  const resolved = await resolveCollection(appId, collectionName, userId);
  if ("error" in resolved) return resolved.error;
  const { collection, collectionDef } = resolved;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return apiError("Request body must be valid JSON", 400);
  }

  const idParsed = MutationIdSchema.safeParse(rawBody);
  if (!idParsed.success) return apiError('A "id" (UUID) is required in the body for PUT.', 400);

  const existing = await prisma.record.findFirst({
    where: { id: idParsed.data.id, collectionId: collection.id },
  });
  if (!existing) return apiError("Record not found in this collection", 404);

  let sanitizedData: Record<string, unknown>;
  try {
    sanitizedData = sanitizeRecordData(collectionDef, rawBody);
  } catch (err) {
    if (err instanceof z.ZodError) return apiError("Record validation failed", 422, err.flatten());
    throw err;
  }

  const updated = await prisma.record.update({ where: { id: idParsed.data.id }, data: { data: sanitizedData } });

  return apiSuccess({
    id: updated.id, data: updated.data, createdAt: updated.createdAt, updatedAt: updated.updatedAt,
  }) as NextResponse;
}

// ── PATCH ─────────────────────────────────────────────────────────────────────

async function handlePatch(
  req: Request,
  appId: string,
  collectionName: string,
  userId: string
): Promise<NextResponse> {
  const resolved = await resolveCollection(appId, collectionName, userId);
  if ("error" in resolved) return resolved.error;
  const { collection, collectionDef } = resolved;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return apiError("Request body must be valid JSON", 400);
  }

  const idParsed = MutationIdSchema.safeParse(rawBody);
  if (!idParsed.success) return apiError('A "id" (UUID) is required in the body for PATCH.', 400);

  const existing = await prisma.record.findFirst({
    where: { id: idParsed.data.id, collectionId: collection.id },
  });
  if (!existing) return apiError("Record not found in this collection", 404);

  const patchSchema = buildPatchSchema(collectionDef);
  let partialData: Record<string, unknown>;
  try {
    partialData = patchSchema.parse(rawBody) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof z.ZodError) return apiError("Record validation failed", 422, err.flatten());
    throw err;
  }

  // Remove id key before merging
  const { id: _removedId, ...patchFields } = partialData;
  void _removedId;

  const existingData =
    typeof existing.data === "object" && existing.data !== null
      ? (existing.data as Record<string, unknown>)
      : {};

  const mergedData: Record<string, unknown> = { ...existingData, ...patchFields };
  const updated = await prisma.record.update({ where: { id: idParsed.data.id }, data: { data: mergedData } });

  return apiSuccess({
    id: updated.id, data: updated.data, createdAt: updated.createdAt, updatedAt: updated.updatedAt,
  }) as NextResponse;
}

// ── DELETE ────────────────────────────────────────────────────────────────────

async function handleDelete(
  req: Request,
  appId: string,
  collectionName: string,
  userId: string
): Promise<NextResponse> {
  const resolved = await resolveCollection(appId, collectionName, userId);
  if ("error" in resolved) return resolved.error;
  const { collection } = resolved;

  const { searchParams } = new URL(req.url);
  let recordId = searchParams.get("id");

  if (!recordId) {
    let rawBody: unknown;
    try { rawBody = await req.json(); } catch { rawBody = {}; }
    const idParsed = MutationIdSchema.safeParse(rawBody);
    if (!idParsed.success) {
      return apiError('Record "id" must be a query param or in the body.', 400);
    }
    recordId = idParsed.data.id;
  } else {
    const idParsed = MutationIdSchema.safeParse({ id: recordId });
    if (!idParsed.success) return apiError("Record id must be a valid UUID", 400);
  }

  const existing = await prisma.record.findFirst({
    where: { id: recordId, collectionId: collection.id },
  });
  if (!existing) return apiError("Record not found in this collection", 404);

  await prisma.record.delete({ where: { id: recordId } });
  return apiSuccess({ deleted: true, id: recordId }) as NextResponse;
}

// ── Route dispatcher ──────────────────────────────────────────────────────────

const routeHandler: RouteHandler = async (req, { params }) => {
  const authResult = requireAuth(req);
  if ("response" in authResult) return authResult.response;
  const { ctx } = authResult;

  const { appId, collectionName } = params;
  if (!appId || !collectionName) {
    return apiError("appId and collectionName are required route parameters", 400);
  }

  switch (req.method) {
    case "GET":    return handleGet(req, appId, collectionName, ctx.userId);
    case "POST":   return handlePost(req, appId, collectionName, ctx.userId);
    case "PUT":    return handlePut(req, appId, collectionName, ctx.userId);
    case "PATCH":  return handlePatch(req, appId, collectionName, ctx.userId);
    case "DELETE": return handleDelete(req, appId, collectionName, ctx.userId);
    default:       return apiError(`Method ${req.method} is not supported`, 405);
  }
};

const wrapped = withErrorBoundary(routeHandler);

export const GET    = wrapped;
export const POST   = wrapped;
export const PUT    = wrapped;
export const PATCH  = wrapped;
export const DELETE = wrapped;
