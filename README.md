# Metadata-Driven Application Runtime Engine

A backend runtime that converts JSON configuration into fully functional, authenticated, user-scoped CRUD APIs — without executing live DDL migrations.

---

## Architecture Overview

```
POST /api/apps/deploy
        │
        ▼
┌─────────────────────────────────┐
│   Ingestion Normalizer          │  ← Zod safe-parse + coercion
│   (config-normalizer.ts)        │     Never throws. Always produces
│                                 │     a valid AppConfig + warnings.
└─────────────────┬───────────────┘
                  │
                  ▼
        Persist App.config (JSONB)
        Pre-register Collection rows
                  │
                  ▼
POST/GET/PUT/PATCH/DELETE /api/runtime/[appId]/[collectionName]
        │
        ▼
┌─────────────────────────────────┐
│   Runtime Schema Factory        │  ← Builds a Zod schema from
│   (schema-factory.ts)           │     App.config metadata at
│                                 │     request time — no code gen.
└─────────────────┬───────────────┘
                  │
                  ▼
        Validate / sanitize payload
        Store in Record.data (JSONB)
```

### Database Strategy — JSONB Hybrid

Instead of executing `ALTER TABLE` DDL at runtime (which is unsafe under concurrency and can corrupt a shared schema), the engine uses a **structured Prisma schema with JSONB storage**:

| Model      | Purpose                                              |
|------------|------------------------------------------------------|
| `User`     | Auth identity                                        |
| `App`      | Config blueprint (raw + sanitized JSON in `config`)  |
| `Collection` | Named table-equivalent, one row per config entity  |
| `Record`   | Actual data rows — schema enforced at app layer      |

This gives full relational ownership and cascade deletes while remaining entirely schema-migration-free at runtime.

---

## Project Structure

```
runtime-engine/
├── prisma/
│   └── schema.prisma          # Fixed schema — never modified at runtime
├── src/
│   ├── lib/
│   │   ├── prisma.ts           # Singleton Prisma client
│   │   ├── auth.ts             # JWT sign/verify + auth extraction
│   │   ├── api-response.ts     # Global error boundary + response helpers
│   │   ├── config-normalizer.ts # Ingestion sanitization engine
│   │   └── schema-factory.ts   # Runtime Zod schema builder
│   └── types/
│       └── config.ts           # TypeScript types (AppConfig, FieldDefinition, …)
└── app/api/
    ├── auth/
    │   ├── register/route.ts   # POST /api/auth/register
    │   └── login/route.ts      # POST /api/auth/login
    ├── apps/
    │   ├── deploy/route.ts     # POST /api/apps/deploy   ← ingestion engine
    │   └── list/route.ts       # GET  /api/apps/list
    └── runtime/
        └── [appId]/
            └── [collectionName]/
                └── route.ts    # GET/POST/PUT/PATCH/DELETE ← CRUD gateway
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — set DATABASE_URL and JWT_SECRET
```

### 3. Run migrations

```bash
npx prisma db push      # development (syncs schema without migration files)
# OR
npx prisma migrate deploy  # production (runs migration files)
```

### 4. Generate Prisma client

```bash
npx prisma generate
```

### 5. Start the dev server

```bash
npm run dev
```

---

## API Reference

### Authentication

All routes except `/api/auth/*` require one of:

| Method | Header | Value |
|--------|--------|-------|
| JWT (production) | `Authorization` | `Bearer <token>` |
| Mock (demo) | `x-user-id` | `<userId UUID>` |

The mock header is for evaluation convenience. Remove it in production.

---

### POST `/api/auth/register`

```json
{ "email": "dev@example.com", "password": "supersecret123" }
```

**Response**
```json
{
  "success": true,
  "data": {
    "token": "<jwt>",
    "user": { "id": "...", "email": "...", "createdAt": "..." }
  }
}
```

---

### POST `/api/auth/login`

Same body/response shape as register.

---

### POST `/api/apps/deploy`

Deploy an app from a JSON config. **The config may be broken — the engine normalizes it gracefully.**

**Example (clean config)**
```json
{
  "name": "Task Tracker",
  "description": "Simple task management app",
  "collections": [
    {
      "name": "tasks",
      "fields": [
        { "name": "title",    "type": "String",  "required": true },
        { "name": "status",   "type": "String",  "required": false, "defaultValue": "open" },
        { "name": "priority", "type": "Number",  "required": false },
        { "name": "done",     "type": "Boolean", "required": false }
      ]
    }
  ]
}
```

**Example (broken config — will be normalized)**
```json
{
  "collections": [
    {
      "fields": [
        { "type": "widget",  "required": "yes" },
        { "name": "score",   "type": "int" },
        { "name": "payload", "type": { "nested": "object" } }
      ]
    }
  ]
}
```

**Response includes normalization warnings:**
```json
{
  "success": true,
  "data": {
    "app": { "id": "...", "name": "Untitled App", "collections": [...] },
    "normalizationWarnings": [
      "App \"name\" is missing — defaulting to \"Untitled App\".",
      "Collection at index 0 has no valid name — using \"collection_0\".",
      "Field at index 0 has no valid name — using \"field_0\".",
      "Unknown field type \"widget\" — defaulting to \"String\".",
      "Field \"payload\" has a complex defaultValue — ignoring it."
    ]
  }
}
```

---

### GET `/api/apps/list`

Returns all apps owned by the caller.

---

### GET `/api/runtime/:appId/:collectionName`

List records. Supports pagination and filtering.

**Query params:**
- `?page=1&pageSize=20`
- `?filter[status]=open&filter[priority]=1`

---

### POST `/api/runtime/:appId/:collectionName`

Create a record. Body is validated against the dynamic Zod schema built from the app's config.

```json
{ "title": "Fix login bug", "status": "open", "priority": 1 }
```

Missing optional fields are filled with defaults. Unknown fields are stripped silently. Invalid required fields return `422`.

---

### PUT `/api/runtime/:appId/:collectionName`

Full replace. Requires `id` in body.

```json
{ "id": "<record-uuid>", "title": "Updated title", "status": "closed" }
```

---

### PATCH `/api/runtime/:appId/:collectionName`

Partial update. Deep-merges patch fields onto existing data.

```json
{ "id": "<record-uuid>", "status": "closed" }
```

---

### DELETE `/api/runtime/:appId/:collectionName`

Delete a record. Provide `id` as query param or in body.

```
DELETE /api/runtime/abc/tasks?id=<record-uuid>
```

---

## Error Response Format

Every response — success or failure — conforms to:

```typescript
{
  success: boolean;
  data?: unknown;      // present on success
  error?: string;      // present on failure
  details?: unknown;   // Zod flatten output, extra context
}
```

The global error boundary (`withErrorBoundary`) catches:
- `ZodError` → 422 with field-level details
- `PrismaClientKnownRequestError` → mapped to semantic HTTP codes (409, 404, 400…)
- `PrismaClientInitializationError` → 503 (DB unavailable)
- Unexpected errors → 500 (message sanitized, full trace logged server-side only)

Raw database errors and stack traces are **never** exposed to the client.

---

## Edge Case Handling Matrix

| Scenario | Behaviour |
|---|---|
| Missing `name` in app config | Defaults to `"Untitled App"` |
| Unknown field type (`widget`, `{}`, etc.) | Coerced to `"String"` |
| Non-array `fields` value | Replaced with `[]` + warning |
| Duplicate collection names | First kept, duplicates dropped + warned |
| Empty collections array | Injects a default `items` collection |
| Numeric field missing in POST | Defaults to `0` |
| Boolean field missing | Defaults to `false` |
| Unknown fields in record payload | Stripped silently (not rejected) |
| Malformed JSON body | 400 with friendly message |
| Access to another user's app | 404 (not 403 — prevents enumeration) |
| Collection in config but not in DB | 500 with re-deploy instructions |
| Invalid UUID for record id | 400 with Zod error |
| Prisma unique constraint violation | 409 Conflict |

---

## Deployment

### Vercel + Neon (recommended)

1. Push repo to GitHub
2. Import into Vercel
3. Create a Neon PostgreSQL database
4. Set env vars in Vercel: `DATABASE_URL`, `JWT_SECRET`
5. Add build command: `prisma generate && next build`

### Railway / Render

Set the same env vars. Use `prisma migrate deploy` as a pre-deploy step.
