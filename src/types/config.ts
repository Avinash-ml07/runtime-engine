// ---------------------------------------------------------------------------
// Canonical types for the metadata-driven runtime engine
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Field-level types
// ---------------------------------------------------------------------------

/** Normalized set of field types the runtime understands */
export type FieldType =
  | "String"
  | "Number"
  | "Boolean"
  | "Date"
  | "Email"
  | "URL"
  | "Text"; // alias for long string / textarea

/** A single field definition inside a collection schema */
export interface FieldDefinition {
  name: string;
  type: FieldType;
  required: boolean;
  defaultValue?: string | number | boolean | null;
  description?: string;
}

// ---------------------------------------------------------------------------
// Collection-level types
// ---------------------------------------------------------------------------

/** A logical collection (table-equivalent) defined in the app config */
export interface CollectionDefinition {
  name: string; // slug-safe identifier
  displayName?: string;
  fields: FieldDefinition[];
}

// ---------------------------------------------------------------------------
// App-level config blueprint
// This is what gets stored in App.config (the Json column)
// ---------------------------------------------------------------------------

export interface AppConfig {
  name: string;
  description?: string;
  version?: string;
  collections: CollectionDefinition[];
}

// ---------------------------------------------------------------------------
// Normalizer output — the result of sanitizing a raw/unknown payload
// ---------------------------------------------------------------------------

export interface NormalizationResult {
  config: AppConfig;
  warnings: string[]; // human-readable notes about what was coerced / defaulted
}

// ---------------------------------------------------------------------------
// Runtime record shape
// ---------------------------------------------------------------------------

export interface RuntimeRecord {
  id: string;
  collectionId: string;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
