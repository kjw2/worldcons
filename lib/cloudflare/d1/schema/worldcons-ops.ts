import type { D1TableDefinition } from "../types";
import { buildTable, uniqueIndex, type TableSpec } from "./shared";

/** Postgres `site_events_event_type_check` values (after the security_event addition). */
export const SITE_EVENT_TYPE_VALUES = [
  "page_view",
  "article_view",
  "search",
  "tag_click",
  "tag_view",
  "source_view",
  "article_click",
  "external_link_click",
  "security_event",
  "admin_action",
  "admin_review_action",
] as const;

const siteEvents: TableSpec = {
  name: "site_events",
  database: "worldcons_ops",
  primaryKey: ["id"],
  note: "raw client_ip / user_agent / client_region / client_city were dropped by the analytics privacy migration",
  columns: [
    { name: "id", type: "uuid", nn: true, note: "application-generated UUID" },
    { name: "occurred_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "event_type", type: "text", nn: true, enum: SITE_EVENT_TYPE_VALUES },
    { name: "path", type: "text" },
    { name: "article_id", type: "uuid" },
    { name: "article_slug", type: "text" },
    { name: "article_title", type: "text" },
    { name: "tag_slug", type: "text" },
    { name: "tag_name", type: "text" },
    { name: "source_key", type: "text" },
    { name: "jurisdiction", type: "text" },
    { name: "institution_name", type: "text" },    { name: "search_query", type: "text" },
    { name: "search_mode", type: "text" },
    { name: "result_count", type: "integer" },
    { name: "referrer_host", type: "text" },
    { name: "user_agent_family", type: "text" },
    { name: "device_type", type: "text" },
    { name: "metadata", type: "jsonb", nn: true, def: "'{}'" },
    { name: "client_ip_hash", type: "text", note: "hashed client identifier only (raw IP intentionally removed)" },
    { name: "accept_language", type: "text" },
    { name: "client_country", type: "text" },
    { name: "is_bot", type: "boolean", nn: true, def: "0" },
  ],
};

const adminJobs: TableSpec = {
  name: "admin_jobs",
  database: "worldcons_ops",
  primaryKey: ["id"],
  indexes: [uniqueIndex("admin_jobs_idempotency_key_key", ["idempotency_key"])],
  columns: [
    { name: "id", type: "uuid", nn: true, note: "application-generated UUID" },
    { name: "job_type", type: "text", nn: true },
    { name: "status", type: "text", nn: true, def: "'queued'" },
    { name: "priority", type: "integer", nn: true, def: "0" },
    { name: "source_key", type: "text" },
    { name: "article_id", type: "uuid" },
    { name: "article_slug", type: "text" },
    { name: "idempotency_key", type: "text", nn: true },    { name: "requested_by", type: "text" },
    { name: "requested_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "started_at", type: "timestamptz" },
    { name: "finished_at", type: "timestamptz" },
    { name: "lease_until", type: "timestamptz" },
    { name: "worker_id", type: "text" },
    { name: "progress_current", type: "integer", nn: true, def: "0" },
    { name: "progress_total", type: "integer" },
    { name: "result_summary", type: "jsonb", nn: true, def: "'{}'" },
    { name: "error_class", type: "text" },
    { name: "error_message", type: "text" },
    { name: "cancel_requested_at", type: "timestamptz" },
    { name: "cancelled_at", type: "timestamptz" },
    { name: "cancel_reason", type: "text" },
    { name: "parent_job_id", type: "uuid", note: "logical self-FK to admin_jobs.id" },
    { name: "options", type: "jsonb", nn: true, def: "'{}'" },
    { name: "created_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "updated_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
  ],
};
const adminJobEvents: TableSpec = {
  name: "admin_job_events",
  database: "worldcons_ops",
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "uuid", nn: true, note: "application-generated UUID" },
    { name: "job_id", type: "uuid", nn: true, note: "logical FK to admin_jobs.id" },
    { name: "occurred_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "event_type", type: "text", nn: true },
    { name: "message", type: "text" },
    { name: "error_class", type: "text" },
    { name: "metadata", type: "jsonb", nn: true, def: "'{}'" },
  ],
};

const adminAuditLogs: TableSpec = {
  name: "admin_audit_logs",
  database: "worldcons_ops",
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "uuid", nn: true, note: "application-generated UUID" },
    { name: "occurred_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "actor_id", type: "text" },
    { name: "actor_role", type: "text", def: "'admin'" },
    { name: "action", type: "text", nn: true },
    { name: "target_type", type: "text" },
    { name: "target_id", type: "text" },
    { name: "article_id", type: "uuid" },    { name: "article_slug", type: "text" },
    { name: "source_key", type: "text" },
    { name: "job_id", type: "text" },
    { name: "result", type: "text" },
    { name: "error_class", type: "text" },
    { name: "redacted_metadata", type: "jsonb", nn: true, def: "'{}'", note: "secrets are redacted before storage" },
    { name: "request_ip_hash", type: "text", note: "hashed client identifier only" },
    { name: "user_agent_family", type: "text" },
  ],
};

const adminArticleEditHistory: TableSpec = {
  name: "admin_article_edit_history",
  database: "worldcons_ops",
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "uuid", nn: true, note: "application-generated UUID" },
    { name: "article_id", type: "uuid", nn: true, note: "logical FK to articles.id" },
    { name: "article_slug", type: "text" },
    { name: "edited_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "actor_id", type: "text" },
    { name: "changed_fields", type: "text[]", nn: true, def: "'{}'", note: "array -> canonical JSON TEXT" },
    { name: "previous_summary_hash", type: "text" },
    { name: "next_summary_hash", type: "text" },
    { name: "diff_redacted", type: "jsonb", nn: true, def: "'{}'", note: "secrets are redacted before storage" },
  ],
};
const llmSettings: TableSpec = {
  name: "llm_settings",
  database: "worldcons_ops",
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "text", nn: true, note: "text primary key (not a UUID)" },
    { name: "settings", type: "jsonb", nn: true, def: "'{}'" },
    { name: "created_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "updated_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
  ],
};

export const opsTables: D1TableDefinition[] = [
  siteEvents,
  adminJobs,
  adminJobEvents,
  adminAuditLogs,
  adminArticleEditHistory,
  llmSettings,
].map(buildTable);