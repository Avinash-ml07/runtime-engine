import { z } from "zod";
import type {
  AppConfig,
  CollectionDefinition,
  FieldDefinition,
  FieldType,
  NormalizationResult,
} from "@/types/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Slugify a string to a safe collection/field name */
function slugify(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 64)
    || fallback;
}

/** Normalize an unknown field type string to a canonical FieldType */
function normalizeFieldType(raw: unknown, warnings: string[]): FieldType {
  const KNOWN: Record<string, FieldType> = {
    string: "String",
    str: "String",
    text: "Text",
    textarea: "Text",
    number: "Number",
    int: "Number",
    integer: "Number",
    float: "Number",
    double: "Number",
    decimal: "Number",
    boolean: "Boolean",
    bool: "Boolean",
    date: "Date",
    datetime: "Date",
    timestamp: "Date",
    email: "Email",
    url: "URL",
    uri: "URL",
    link: "URL",
  };

  if (typeof raw === "string") {
    const normalized = KNOWN[raw.trim().toLowerCase()];
    if (normalized) return normalized;
  }

  warnings.push(
    `Unknown field type "${String(raw)}" — defaulting to "String".`
  );
  return "String";
}

// ---------------------------------------------------------------------------
// Zod schemas for safe-parsing the incoming (possibly broken) payload
// ---------------------------------------------------------------------------

// We use z.unknown() + manual coercion rather than strict schemas so that
// we can produce warnings instead of hard failures for every bad field.

const RawFieldSchema = z.object({
  name: z.unknown().optional(),
  type: z.unknown().optional(),
  required: z.unknown().optional(),
  defaultValue: z.unknown().optional(),
  description: z.unknown().optional(),
});

const RawCollectionSchema = z.object({
  name: z.unknown().optional(),
  displayName: z.unknown().optional(),
  fields: z.unknown().optional(),
});

const RawAppConfigSchema = z.object({
  name: z.unknown().optional(),
  description: z.unknown().optional(),
  version: z.unknown().optional(),
  collections: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// Field normalizer
// ---------------------------------------------------------------------------

function normalizeField(
  raw: unknown,
  index: number,
  warnings: string[]
): FieldDefinition {
  const parsed = RawFieldSchema.safeParse(raw);
  const rawField = parsed.success ? parsed.data : {};

  const name = slugify(rawField.name, `field_${index}`);

  if (!parsed.success || typeof rawField.name !== "string" || !rawField.name.trim()) {
    warnings.push(
      `Field at index ${index} has no valid name — using "${name}".`
    );
  }

  const type = normalizeFieldType(rawField.type ?? "String", warnings);

  // required: coerce truthy values; missing → false
  let required = false;
  if (rawField.required !== undefined) {
    if (typeof rawField.required === "boolean") {
      required = rawField.required;
    } else if (
      typeof rawField.required === "string" &&
      rawField.required.toLowerCase() === "true"
    ) {
      required = true;
    } else if (typeof rawField.required === "number") {
      required = rawField.required !== 0;
    } else {
      warnings.push(
        `Field "${name}" has non-boolean "required" value — defaulting to false.`
      );
    }
  }

  // defaultValue: accept primitive types only; discard objects/arrays
  let defaultValue: FieldDefinition["defaultValue"] = null;
  const dv = rawField.defaultValue;
  if (
    dv !== undefined &&
    dv !== null &&
    ["string", "number", "boolean"].includes(typeof dv)
  ) {
    defaultValue = dv as string | number | boolean;
  } else if (dv !== undefined && dv !== null) {
    warnings.push(
      `Field "${name}" has a complex defaultValue — ignoring it.`
    );
  }

  const description =
    typeof rawField.description === "string"
      ? rawField.description.trim().slice(0, 500)
      : undefined;

  return { name, type, required, defaultValue, description };
}

// ---------------------------------------------------------------------------
// Collection normalizer
// ---------------------------------------------------------------------------

function normalizeCollection(
  raw: unknown,
  index: number,
  warnings: string[]
): CollectionDefinition {
  const parsed = RawCollectionSchema.safeParse(raw);
  const rawColl = parsed.success ? parsed.data : {};

  const name = slugify(rawColl.name, `collection_${index}`);

  if (
    !parsed.success ||
    typeof rawColl.name !== "string" ||
    !rawColl.name.trim()
  ) {
    warnings.push(
      `Collection at index ${index} has no valid name — using "${name}".`
    );
  }

  const displayName =
    typeof rawColl.displayName === "string"
      ? rawColl.displayName.trim().slice(0, 128)
      : undefined;

  // Normalize fields — must be an array; if not, start with an empty list
  let fields: FieldDefinition[] = [];
  if (Array.isArray(rawColl.fields)) {
    fields = rawColl.fields.map((f: unknown, i: number) =>
      normalizeField(f, i, warnings)
    );
  } else if (rawColl.fields !== undefined && rawColl.fields !== null) {
    warnings.push(
      `Collection "${name}" has a non-array "fields" value — starting with an empty field list.`
    );
  }

  // Inject a safe default `id` field if none is present (for display purposes)
  // The actual PK lives in the Record model, so this is purely metadata.
  if (fields.length === 0) {
    warnings.push(
      `Collection "${name}" has no fields — injecting a default "title" (String) field.`
    );
    fields.push({
      name: "title",
      type: "String",
      required: true,
      defaultValue: null,
    });
  }

  return { name, displayName, fields };
}

// ---------------------------------------------------------------------------
// Top-level normalizer — the public API of this module
// ---------------------------------------------------------------------------

export function normalizeAppConfig(raw: unknown): NormalizationResult {
  const warnings: string[] = [];

  const parsed = RawAppConfigSchema.safeParse(raw);
  const rawConfig = parsed.success ? parsed.data : {};

  if (!parsed.success) {
    warnings.push(
      "Root config shape is not a plain object — attempting best-effort extraction."
    );
  }

  // App name
  let name: string;
  if (typeof rawConfig.name === "string" && rawConfig.name.trim()) {
    name = rawConfig.name.trim().slice(0, 128);
  } else {
    name = "Untitled App";
    warnings.push('App "name" is missing or invalid — defaulting to "Untitled App".');
  }

  // Description
  const description =
    typeof rawConfig.description === "string"
      ? rawConfig.description.trim().slice(0, 500)
      : undefined;

  // Version
  const version =
    typeof rawConfig.version === "string"
      ? rawConfig.version.trim().slice(0, 32)
      : "1.0.0";

  // Collections
  let collections: CollectionDefinition[] = [];

  if (Array.isArray(rawConfig.collections) && rawConfig.collections.length > 0) {
    collections = rawConfig.collections.map((c: unknown, i: number) =>
      normalizeCollection(c, i, warnings)
    );
  } else {
    warnings.push(
      '"collections" is missing or empty — injecting a default "items" collection.'
    );
    collections = [
      {
        name: "items",
        displayName: "Items",
        fields: [
          { name: "title", type: "String", required: true, defaultValue: null },
          { name: "description", type: "Text", required: false, defaultValue: null },
        ],
      },
    ];
  }

  // Deduplicate collection names (keep first, warn on duplicates)
  const seenCollectionNames = new Set<string>();
  collections = collections.filter((c) => {
    if (seenCollectionNames.has(c.name)) {
      warnings.push(
        `Duplicate collection name "${c.name}" found — dropping subsequent definition.`
      );
      return false;
    }
    seenCollectionNames.add(c.name);
    return true;
  });

  const config: AppConfig = { name, description, version, collections };
  return { config, warnings };
}
