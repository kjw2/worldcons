import type { D1RelocatedTarget, D1StorageKind } from "./types";

/**
 * Postgres -> D1 type mapping (plan section 6.1).
 *
 * This is an application mapping, not SQL translation: UUIDs become
 * application-generated TEXT, timestamps become normalized UTC ISO-8601 TEXT,
 * `jsonb` becomes canonical JSON TEXT, booleans become INTEGER 0/1, arrays
 * become canonical JSON TEXT, and `tsvector` / `vector(1536)` are relocated to
 * FTS5 / Vectorize instead of becoming D1 columns.
 */
export interface D1StorageMapping {
  kind: D1StorageKind;
  note: string;
}
export interface D1RelocatedMapping {
  relocated: D1RelocatedTarget;
  note: string;
}
export type D1TypeMapping = D1StorageMapping | D1RelocatedMapping;

/** Documentary rules surfaced in the M5.1 schema report. */
export const POSTGRES_TYPE_MAPPING_RULES: readonly { pattern: string; target: string; note: string }[] = [
  { pattern: "uuid", target: "text", note: "application-generated UUID (no gen_random_uuid default)" },
  { pattern: "text / varchar / citext", target: "text", note: "text family is stored verbatim" },
  { pattern: "timestamptz / timestamp / date / time", target: "text", note: "normalized UTC ISO-8601 with milliseconds" },
  { pattern: "jsonb / json", target: "text", note: "canonical JSON text (sorted keys)" },
  { pattern: "boolean", target: "integer", note: "0 / 1" },
  { pattern: "smallint / integer / serial", target: "integer", note: "JS-safe integer" },
  { pattern: "bigint / bigserial", target: "text", note: "decimal TEXT unless proven JS-safe" },
  { pattern: "numeric / double precision / real", target: "real", note: "SQLite REAL (double)" },
  { pattern: "text[] / arrays", target: "text", note: "canonical JSON array text" },
  { pattern: "enums (create type ... as enum)", target: "text", note: "TEXT + CHECK constraint" },
  { pattern: "bytea", target: "blob", note: "BLOB" },
  { pattern: "tsvector", target: "fts5", note: "relocated to an FTS5 projection (plan 11.1)" },
  { pattern: "vector(1536)", target: "vectorize", note: "relocated to a Vectorize index (plan 11.2)" },
];
const TEXT_TYPES = new Set(["text", "citext", "name", "character varying", "varchar", "character", "char"]);
const TIMESTAMP_TYPES = new Set([
  "timestamptz",
  "timestamp with time zone",
  "timestamp without time zone",
  "timestamp",
  "date",
  "time",
  "time with time zone",
  "time without time zone",
  "interval",
]);
const JSON_TYPES = new Set(["jsonb", "json"]);
const BOOLEAN_TYPES = new Set(["boolean", "bool"]);
const INTEGER_TYPES = new Set(["smallint", "int2", "integer", "int", "int4", "serial", "serial4"]);
const BIGINT_TYPES = new Set(["bigint", "int8", "bigserial", "serial8"]);
const REAL_TYPES = new Set(["numeric", "decimal", "double precision", "real", "float4", "float8", "float", "money"]);
const BLOB_TYPES = new Set(["bytea"]);
/**
 * Matches a pgvector column type, optionally schema-qualified. The live
 * migrations declare `vector(1536)` in one place and `extensions.vector(1536)`
 * (pgvector installed in the `extensions` schema) in another; both are the same
 * type and both relocate to Vectorize (plan 6.1 / 11.2).
 */
const VECTOR_TYPE = /^(?:[a-z_][a-z0-9_]*\.)?vector(\(\s*\d+\s*\))?$/;

/** Normalizes a raw Postgres type name for comparison and mapping. */
export function normalizePostgresType(rawType: string): string {
  return rawType.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Maps a Postgres column type to its D1 target. Returns `null` for an unmapped
 * type so validation can fail closed rather than silently defaulting to `text`.
 */
export function mapPostgresType(
  rawType: string,
  enumNames: ReadonlySet<string> = new Set<string>(),
): D1TypeMapping | null {
  const type = normalizePostgresType(rawType);
  if (!type) return null;
  if (type === "tsvector") {
    return { relocated: "fts5", note: "tsvector -> FTS5 projection (plan 6.1 / 11.1)" };
  }
  if (VECTOR_TYPE.test(type)) {
    return { relocated: "vectorize", note: "vector(1536) -> Vectorize (plan 6.1 / 11.2)" };
  }
  if (type.endsWith("[]")) {
    return { kind: "text", note: "Postgres array -> canonical JSON TEXT" };
  }
  if (enumNames.has(type)) {
    return { kind: "text", note: "Postgres enum -> TEXT + CHECK" };
  }  if (type === "uuid") return { kind: "text", note: "uuid -> TEXT, application-generated" };
  if (TEXT_TYPES.has(type)) return { kind: "text", note: "text family -> TEXT" };
  if (TIMESTAMP_TYPES.has(type)) return { kind: "text", note: "time family -> normalized UTC ISO-8601 TEXT" };
  if (JSON_TYPES.has(type)) return { kind: "text", note: "jsonb -> canonical JSON TEXT" };
  if (BOOLEAN_TYPES.has(type)) return { kind: "integer", note: "boolean -> INTEGER 0/1" };
  if (INTEGER_TYPES.has(type)) return { kind: "integer", note: "integer -> INTEGER" };
  if (BIGINT_TYPES.has(type)) return { kind: "text", note: "bigint -> decimal TEXT unless proven JS-safe" };
  if (REAL_TYPES.has(type)) return { kind: "real", note: "numeric/float -> REAL" };
  if (BLOB_TYPES.has(type)) return { kind: "blob", note: "bytea -> BLOB" };
  return null;
}
/** The canonical conversion family for a mapped Postgres type (M5 canonical foundation). */
export const D1_CANONICAL_KINDS = [
  "text",
  "uuid",
  "timestamp",
  "json",
  "array",
  "bigint",
  "boolean",
  "integer",
  "real",
  "blob",
  "fts5",
  "vectorize",
] as const;
export type D1CanonicalKind = (typeof D1_CANONICAL_KINDS)[number];

/** Maps a Postgres type to the canonical converter family it needs. */
export function postgresTypeCanonicalKind(
  rawType: string,
  enumNames: ReadonlySet<string> = new Set<string>(),
): D1CanonicalKind | null {
  const type = normalizePostgresType(rawType);
  if (!type) return null;
  if (type === "tsvector") return "fts5";
  if (VECTOR_TYPE.test(type)) return "vectorize";
  if (type.endsWith("[]")) return "array";
  if (enumNames.has(type)) return "text";
  if (type === "uuid") return "uuid";
  if (TIMESTAMP_TYPES.has(type)) return "timestamp";
  if (JSON_TYPES.has(type)) return "json";
  if (BOOLEAN_TYPES.has(type)) return "boolean";
  if (INTEGER_TYPES.has(type)) return "integer";
  if (BIGINT_TYPES.has(type)) return "bigint";
  if (REAL_TYPES.has(type)) return "real";
  if (BLOB_TYPES.has(type)) return "blob";
  if (TEXT_TYPES.has(type)) return "text";
  return null;
}