import type { D1TableDefinition } from "../types";
import { buildTable, uniqueIndex, type TableSpec } from "./shared";

/** Postgres `source_url_candidates_status_check` values. */
export const SOURCE_URL_CANDIDATE_STATUS_VALUES = ["pending", "retrying", "fetched", "failed", "ignored"] as const;

const ingestionRuns: TableSpec = {
  name: "ingestion_runs",
  database: "worldcons_ingest",
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "uuid", nn: true, note: "application-generated UUID" },
    { name: "source_key", type: "text", nn: true },
    { name: "started_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "finished_at", type: "timestamptz" },
    { name: "status", type: "text", nn: true },
    { name: "discovered_count", type: "integer", nn: true, def: "0" },
    { name: "fetched_count", type: "integer", nn: true, def: "0" },
    { name: "summarized_count", type: "integer", nn: true, def: "0" },
    { name: "failed_count", type: "integer", nn: true, def: "0" },
    { name: "error_message", type: "text" },
    { name: "metadata", type: "jsonb" },
  ],
};
const sourceUrlCandidates: TableSpec = {
  name: "source_url_candidates",
  database: "worldcons_ingest",
  primaryKey: ["id"],
  indexes: [uniqueIndex("source_url_candidates_source_key_url_key", ["source_key", "url"])],
  columns: [
    { name: "id", type: "uuid", nn: true, note: "application-generated UUID" },
    { name: "source_key", type: "text", nn: true },
    { name: "url", type: "text", nn: true },
    { name: "candidate_type", type: "text", nn: true },
    { name: "discovered_by", type: "text", nn: true },
    { name: "status", type: "text", nn: true, def: "'pending'", enum: SOURCE_URL_CANDIDATE_STATUS_VALUES },
    { name: "last_attempt_at", type: "timestamptz" },
    { name: "attempt_count", type: "integer", nn: true, def: "0" },
    { name: "last_error_code", type: "text" },
    { name: "last_error_message", type: "text" },
    { name: "created_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "updated_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
  ],
};

export const ingestTables: D1TableDefinition[] = [ingestionRuns, sourceUrlCandidates].map(buildTable);