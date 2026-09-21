import type { D1TableDefinition } from "../types";
import { buildTable, type TableSpec } from "./shared";

/**
 * `worldcons_search` is a disposable, rebuildable projection (plan 5.4 / 11.1),
 * not a migrated Postgres table. `search_documents` is the denormalized base and
 * `search_fts` is the FTS5 index over it.
 */
const searchDocuments: TableSpec = {
  name: "search_documents",
  database: "worldcons_search",
  primaryKey: ["article_id"],
  note: "derived projection of worldcons_core + R2 (rebuilt, never authoritative)",
  columns: [
    { name: "article_id", type: "text", nn: true, derived: true },
    { name: "jurisdiction", type: "text", derived: true },
    { name: "source_key", type: "text", derived: true },
    { name: "language", type: "text", derived: true },
    { name: "content_type", type: "text", derived: true },
    { name: "publication_state", type: "text", derived: true },
    { name: "review_state", type: "text", derived: true },
    { name: "original_published_at", type: "text", derived: true },
    { name: "display_title", type: "text", derived: true },
    { name: "case_numbers", type: "text", derived: true },
    { name: "search_text", type: "text", derived: true },
    { name: "tags_text", type: "text", derived: true },
    { name: "projection_version", type: "integer", nn: true, def: "1", derived: true },
    { name: "checksum", type: "text", derived: true },
    { name: "updated_at", type: "text", nn: true, derived: true },
  ],
};

const searchFts: TableSpec = {
  name: "search_fts",
  database: "worldcons_search",
  primaryKey: [],
  columns: [],
  note: "FTS5 index over search_documents (plan 6.1 tsvector -> FTS5, plan 11.1)",
  virtual: {
    module: "fts5",
    columns: ["article_id UNINDEXED", "title", "case_numbers", "search_text", "tags_text"],
  },
};

export const searchTables: D1TableDefinition[] = [searchDocuments, searchFts].map(buildTable);