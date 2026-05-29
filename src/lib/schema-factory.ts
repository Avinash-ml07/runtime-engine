import { z, ZodTypeAny } from "zod";
import type { CollectionDefinition, FieldDefinition, FieldType } from "@/types/config";

// ---------------------------------------------------------------------------
// Field-type → Zod schema mapping
// ---------------------------------------------------------------------------

function buildFieldSchema(field: FieldDefinition): ZodTypeAny {
  let schema: ZodTypeAny;

  const type: FieldType = field.type;

  switch (type) {
    case "Number": {
      // Coerce strings to numbers so that JSON-stringified numbers still pass
      schema = z.union([
        z.number(),
        z
          .string()
          .regex(/^-?\d+(\.\d+)?$/, "Must be a numeric value")
          .transform((v) => parseFloat(v)),
      ]);
      break;
    }

    case "Boolean": {
      schema = z.union([
        z.boolean(),
        z.enum(["true", "false"]).transform((v) => v === "true"),
      ]);
      break;
    }

    case "Date": {
      schema = z
        .string()
        .refine((v) => !isNaN(Date.parse(v)), {
          message: "Must be a valid ISO date string",
        })
        .or(z.date().transform((d) => d.toISOString()));
      break;
    }

    case "Email": {
      schema = z.string().email("Must be a valid email address");
      break;
    }

    case "URL": {
      schema = z.string().url("Must be a valid URL");
      break;
    }

    case "Text":
    case "String":
    default: {
      schema = z.string();
      break;
    }
  }

  // Apply default value when field is optional + has a default
  if (!field.required) {
    const defaultVal = resolveDefault(field);
    if (defaultVal !== undefined) {
      return schema.optional().default(defaultVal as string & number & boolean);
    }
    return schema.optional();
  }

  return schema;
}

// ---------------------------------------------------------------------------
// Resolve a sensible default for a field
// ---------------------------------------------------------------------------

function resolveDefault(
  field: FieldDefinition
): string | number | boolean | undefined {
  // Explicit default in config takes priority
  if (field.defaultValue !== null && field.defaultValue !== undefined) {
    return field.defaultValue;
  }

  // Numeric fields always default to 0 (matches bonus/stock/counter spec)
  if (field.type === "Number") return 0;

  // Booleans default to false
  if (field.type === "Boolean") return false;

  return undefined;
}

// ---------------------------------------------------------------------------
// Build a complete Zod object schema for a CollectionDefinition
// ---------------------------------------------------------------------------

export function buildRuntimeSchema(
  collection: CollectionDefinition
): z.ZodObject<Record<string, ZodTypeAny>> {
  const shape: Record<string, ZodTypeAny> = {};

  for (const field of collection.fields) {
    shape[field.name] = buildFieldSchema(field);
  }

  return z.object(shape);
}

// ---------------------------------------------------------------------------
// Sanitize an incoming data payload against a collection schema.
//
// Behaviour:
//   - Strips keys that are not declared in the schema (unknown fields)
//   - Fills missing optional fields with their defaults
//   - Returns cleaned data or throws ZodError for hard validation failures
// ---------------------------------------------------------------------------

export function sanitizeRecordData(
  collection: CollectionDefinition,
  rawData: unknown
): Record<string, unknown> {
  const schema = buildRuntimeSchema(collection);

  // Strip unknown keys by rebuilding the object with only known fields
  const knownKeys = new Set(collection.fields.map((f) => f.name));

  let filtered: Record<string, unknown> = {};

  if (typeof rawData === "object" && rawData !== null) {
    const raw = rawData as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (knownKeys.has(key)) {
        filtered[key] = raw[key];
      }
      // Unknown keys are silently dropped — they won't cause a crash
    }
  }

  // Let Zod fill defaults and validate
  const result = schema.parse(filtered);
  return result as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Build a partial schema for PATCH / UPDATE operations
// (all fields become optional)
// ---------------------------------------------------------------------------

export function buildPatchSchema(
  collection: CollectionDefinition
): z.ZodObject<Record<string, ZodTypeAny>> {
  const base = buildRuntimeSchema(collection);
  return base.partial();
}
