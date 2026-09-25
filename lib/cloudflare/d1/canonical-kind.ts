import { postgresTypeCanonicalKind, type D1CanonicalKind } from "./mapping";
import type { D1ColumnDefinition, D1StorageKind } from "./types";

/**
 * Runtime-safe canonical-kind resolution for a D1 column.
 *
 * This is deliberately isolated from `canonical-row.ts`, which imports a Node
 * builtin for hashing. The Worker shadow-read seam only needs to know which
 * columns store JSON/array canonical text so it can revive them, and it must
 * never pull a Node builtin into the Worker bundle. `canonical-row.ts`
 * re-exports `columnCanonicalKind` from here so the public M5.1 barrel is
 * unchanged.
 */
function storageFallbackKind(kind: D1StorageKind): D1CanonicalKind {
  if (kind === "integer") return "integer";
  if (kind === "real") return "real";
  if (kind === "blob") return "blob";
  return "text";
}

export function columnCanonicalKind(column: D1ColumnDefinition): D1CanonicalKind {
  if (column.enumValues && column.enumValues.length > 0) return "text";
  if (column.source) {
    const kind = postgresTypeCanonicalKind(column.source.postgresType);
    if (kind && kind !== "fts5" && kind !== "vectorize") return kind;
  }
  return storageFallbackKind(column.kind);
}
