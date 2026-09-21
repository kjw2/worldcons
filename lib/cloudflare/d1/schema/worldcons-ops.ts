import type { D1TableDefinition } from "../types";
import { buildTable, index, uniqueIndex, type TableSpec } from "./shared";

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
/** Postgres `admin_command_attempts_status_check` values. */
export const ADMIN_COMMAND_ATTEMPT_STATUS_VALUES = ["running", "succeeded", "failed", "aborted", "lease_expired"] as const;
/** Postgres `admin_command_events_event_type_check` values. */
export const ADMIN_COMMAND_EVENT_TYPE_VALUES = [
  "command_accepted",
  "command_deduplicated",
  "run_queued",
  "compatibility_shadowed",
  "attempt_claimed",
  "lease_reclaimed",
  "heartbeat",
  "attempt_succeeded",
  "retry_scheduled",
  "run_failed",
  "abort_requested",
  "run_aborted",
  "manual_retry_queued",
] as const;
/** Postgres `admin_command_events_actor_type_check` values. */
export const ADMIN_COMMAND_ACTOR_TYPE_VALUES = ["admin", "cron", "worker", "system", "compatibility"] as const;
/** Postgres `admin_command_runs_status_check` values. */
export const ADMIN_COMMAND_RUN_STATUS_VALUES = ["queued", "running", "retry_wait", "succeeded", "failed", "aborted", "shadowed"] as const;
/** Postgres `admin_compat_obs_p5_surface_check` values. */
export const ADMIN_COMPAT_SURFACE_VALUES = [
  "admin_command",
  "article_lifecycle",
  "article_publication",
  "public_query",
  "vector_search",
  "admin_dashboard",
  "admin_analytics",
] as const;
/** Postgres `admin_compat_obs_p5_domain_check` values. */
export const ADMIN_COMPAT_DOMAIN_VALUES = ["queue", "lifecycle", "publication", "projection", "operations"] as const;
/** Postgres `admin_compat_obs_p5_direction_check` values. */
export const ADMIN_COMPAT_DIRECTION_VALUES = ["read", "write"] as const;
/** Postgres `admin_compat_obs_p5_authority_check` values. */
export const ADMIN_COMPAT_AUTHORITY_VALUES = ["legacy", "new", "fallback"] as const;
/** Postgres `admin_compat_obs_p5_outcome_check` values. */
export const ADMIN_COMPAT_OUTCOME_VALUES = [
  "selected",
  "succeeded",
  "failed",
  "fallback",
  "skipped",
  "disabled",
  "unavailable",
] as const;
/** Postgres `admin_governance_evidence_p5_type_check` values. */
export const ADMIN_GOVERNANCE_EVIDENCE_TYPE_VALUES = ["owner_approval", "backup_restore", "acknowledgement"] as const;
/** Postgres `admin_governance_evidence_p5_outcome_check` values. */
export const ADMIN_GOVERNANCE_OUTCOME_VALUES = ["approved", "successful", "acknowledged"] as const;
/** Postgres `admin_retention_holds_p5_domain_check` values. */
export const ADMIN_RETENTION_DOMAIN_VALUES = ["all", "commands", "lifecycle", "publication", "observations", "outbox"] as const;
/** Postgres `ops_workflow_heartbeats_status_check` values. */
export const WORKFLOW_HEARTBEAT_STATUS_VALUES = ["running", "success", "failed", "deferred"] as const;
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
    { name: "institution_name", type: "text" },
    { name: "search_query", type: "text" },
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
    { name: "idempotency_key", type: "text", nn: true },
    { name: "requested_by", type: "text" },
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
    { name: "article_id", type: "uuid" },
    { name: "article_slug", type: "text" },
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
    { name: "changed_fields", type: "text[]", nn: true, def: "'[]'", note: "array -> canonical JSON TEXT (plan 6.1)" },
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
const adminCommandAttempts: TableSpec = {
  name: "admin_command_attempts",
  database: "worldcons_ops",
  primaryKey: ["id"],
  note: "the attempt-number/worker/terminal-shape checks stay in the service layer; fencing_token is application-generated decimal TEXT",
  indexes: [
    index("admin_command_attempts_active_lease_idx", ["lease_expires_at", "run_id"]),
    index("admin_command_attempts_run_created_idx", ["run_id", "attempt_number"]),
  ],
  columns: [
    { name: "id", type: "uuid", nn: true, note: "application-generated UUID" },
    { name: "run_id", type: "uuid", nn: true, note: "logical FK to admin_command_runs.id" },
    { name: "attempt_number", type: "integer", nn: true },
    { name: "status", type: "text", nn: true, enum: ADMIN_COMMAND_ATTEMPT_STATUS_VALUES },
    { name: "worker_id", type: "text", nn: true },
    { name: "fencing_token", type: "bigint", nn: true, note: "decimal TEXT (plan 6.1 bigint rule), application-generated (no sequence)" },
    { name: "lease_expires_at", type: "timestamptz", nn: true },
    { name: "heartbeat_at", type: "timestamptz", nn: true },
    { name: "started_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "finished_at", type: "timestamptz" },
    { name: "failure_disposition", type: "text" },
    { name: "error_code", type: "text" },
    { name: "error_message", type: "text" },
    { name: "result_summary", type: "jsonb", nn: true, def: "'{}'" },
    { name: "created_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "updated_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
  ],
};
const adminCommandEvents: TableSpec = {
  name: "admin_command_events",
  database: "worldcons_ops",
  primaryKey: ["id"],
  note: "append-only admin command event log; the bigint identity id becomes application-generated decimal TEXT",
  indexes: [
    index("admin_command_events_command_occurred_idx", ["command_id", "occurred_at", "id"]),
    index("admin_command_events_run_occurred_idx", ["run_id", "occurred_at", "id"]),
  ],
  columns: [
    { name: "id", type: "bigint", nn: true, note: "decimal TEXT (plan 6.1 bigint rule), application-generated identity" },
    { name: "command_id", type: "uuid", nn: true, note: "logical FK to admin_commands.id" },
    { name: "run_id", type: "uuid", note: "logical FK to admin_command_runs.id" },
    { name: "attempt_id", type: "uuid", note: "logical FK to admin_command_attempts.id" },
    { name: "event_type", type: "text", nn: true, enum: ADMIN_COMMAND_EVENT_TYPE_VALUES },
    { name: "actor_type", type: "text", nn: true, enum: ADMIN_COMMAND_ACTOR_TYPE_VALUES },
    { name: "actor_id", type: "text" },
    { name: "safe_details", type: "jsonb", nn: true, def: "'{}'" },
    { name: "occurred_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
  ],
};
const adminCommandRuns: TableSpec = {
  name: "admin_command_runs",
  database: "worldcons_ops",
  primaryKey: ["id"],
  note: "the dedupe/backoff/terminal-shape checks stay in the service layer; dedupe_key uniqueness is enforced there",
  indexes: [
    uniqueIndex("admin_command_runs_active_dedupe_key_uidx", ["dedupe_key"]),
    index("admin_command_runs_claim_idx", ["status", "available_at", "priority", "created_at"]),
  ],
  columns: [
    { name: "id", type: "uuid", nn: true, note: "application-generated UUID" },
    { name: "command_id", type: "uuid", nn: true, note: "logical FK to admin_commands.id" },
    { name: "run_number", type: "integer", nn: true },
    { name: "status", type: "text", nn: true, def: "'queued'", enum: ADMIN_COMMAND_RUN_STATUS_VALUES },
    { name: "dedupe_key", type: "text", nn: true },
    { name: "priority", type: "integer", nn: true, def: "0" },
    { name: "available_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "max_attempts", type: "integer", nn: true, def: "3" },
    { name: "retry_backoff_base_seconds", type: "integer", nn: true, def: "15" },
    { name: "retry_backoff_cap_seconds", type: "integer", nn: true, def: "900" },
    { name: "retry_count", type: "integer", nn: true, def: "0" },
    { name: "current_attempt_id", type: "uuid", note: "logical FK to admin_command_attempts.id" },
    { name: "abort_requested_at", type: "timestamptz" },
    { name: "abort_requested_by", type: "text" },
    { name: "abort_reason", type: "text" },
    { name: "started_at", type: "timestamptz" },
    { name: "finished_at", type: "timestamptz" },
    { name: "terminal_error_code", type: "text" },
    { name: "terminal_error_message", type: "text" },
    { name: "result_summary", type: "jsonb", nn: true, def: "'{}'" },
    { name: "created_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "updated_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
  ],
};
const adminCommands: TableSpec = {
  name: "admin_commands",
  database: "worldcons_ops",
  primaryKey: ["id"],
  note: "the command-type/idempotency/payload checks stay in the service layer; (command_type, idempotency_key) uniqueness is enforced there",
  columns: [
    { name: "id", type: "uuid", nn: true, note: "application-generated UUID" },
    { name: "command_type", type: "text", nn: true },
    { name: "payload_ref", type: "jsonb", nn: true, def: "'{}'" },
    { name: "idempotency_key", type: "text", nn: true },
    { name: "requested_by", type: "text" },
    { name: "priority", type: "integer", nn: true, def: "0" },
    { name: "created_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
  ],
};
const adminCompatibilityObservationsP5: TableSpec = {
  name: "admin_compatibility_observations_p5",
  database: "worldcons_ops",
  primaryKey: ["bucket_started_at", "surface", "domain", "direction", "authority", "outcome"],
  note: "the hourly-bucket and count checks stay in the service layer",
  columns: [
    { name: "bucket_started_at", type: "timestamptz", nn: true },
    { name: "surface", type: "text", nn: true, enum: ADMIN_COMPAT_SURFACE_VALUES },
    { name: "domain", type: "text", nn: true, enum: ADMIN_COMPAT_DOMAIN_VALUES },
    { name: "direction", type: "text", nn: true, enum: ADMIN_COMPAT_DIRECTION_VALUES },
    { name: "authority", type: "text", nn: true, enum: ADMIN_COMPAT_AUTHORITY_VALUES },
    { name: "outcome", type: "text", nn: true, enum: ADMIN_COMPAT_OUTCOME_VALUES },
    { name: "observation_count", type: "bigint", nn: true, def: "0", note: "decimal TEXT (plan 6.1 bigint rule)" },
    { name: "unexplained_count", type: "bigint", nn: true, def: "0", note: "decimal TEXT (plan 6.1 bigint rule)" },
    { name: "first_observed_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "last_observed_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
  ],
};
const adminGovernanceEvidenceP5: TableSpec = {
  name: "admin_governance_evidence_p5",
  database: "worldcons_ops",
  primaryKey: ["id"],
  note: "the actor/digest/expiry checks stay in the service layer; the bigint identity id becomes application-generated decimal TEXT",
  columns: [
    { name: "id", type: "bigint", nn: true, note: "decimal TEXT (plan 6.1 bigint rule), application-generated identity" },
    { name: "evidence_type", type: "text", nn: true, enum: ADMIN_GOVERNANCE_EVIDENCE_TYPE_VALUES },
    { name: "role_key", type: "text" },
    { name: "outcome", type: "text", nn: true, enum: ADMIN_GOVERNANCE_OUTCOME_VALUES },
    { name: "actor_hash", type: "text", nn: true },
    { name: "evidence_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "expires_at", type: "timestamptz", nn: true },
    { name: "evidence_digest", type: "text", nn: true },
    { name: "note_code", type: "text" },
  ],
};
const adminOpsEvents: TableSpec = {
  name: "admin_ops_events",
  database: "worldcons_ops",
  primaryKey: ["id"],
  note: "the inline event_type/severity value checks are not table-level check constraints in the scan, so they stay in the service layer",
  indexes: [
    index("admin_ops_events_created_at_idx", ["created_at"]),
    index("admin_ops_events_type_idx", ["event_type"]),
    index("admin_ops_events_severity_idx", ["severity"]),
  ],
  columns: [
    { name: "id", type: "uuid", nn: true, note: "application-generated UUID" },
    { name: "event_type", type: "text", nn: true },
    { name: "severity", type: "text", nn: true },
    { name: "source_key", type: "text" },
    { name: "summary", type: "text", nn: true },
    { name: "detail", type: "jsonb", nn: true, def: "'{}'" },
    { name: "created_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
  ],
};
const adminRetentionHoldsP5: TableSpec = {
  name: "admin_retention_holds_p5",
  database: "worldcons_ops",
  primaryKey: ["id"],
  note: "the reason/digest/date checks stay in the service layer; the bigint identity id becomes application-generated decimal TEXT",
  columns: [
    { name: "id", type: "bigint", nn: true, note: "decimal TEXT (plan 6.1 bigint rule), application-generated identity" },
    { name: "domain", type: "text", nn: true, enum: ADMIN_RETENTION_DOMAIN_VALUES },
    { name: "reason_code", type: "text", nn: true },
    { name: "starts_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "expires_at", type: "timestamptz" },
    { name: "released_at", type: "timestamptz" },
    { name: "evidence_digest", type: "text", nn: true },
  ],
};
const masterdashCollectionControl: TableSpec = {
  name: "masterdash_collection_control",
  database: "worldcons_ops",
  primaryKey: ["system_id"],
  note: "the system_id = 'worldcons' inline check stays in the service layer",
  columns: [
    { name: "system_id", type: "text", nn: true },
    { name: "paused", type: "boolean", nn: true, def: "0" },
    { name: "updated_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "last_request_id", type: "uuid", note: "logical FK to masterdash_control_requests.request_id" },
  ],
};
const masterdashControlRequests: TableSpec = {
  name: "masterdash_control_requests",
  database: "worldcons_ops",
  primaryKey: ["request_id"],
  note: "the system_id/action/status inline checks stay in the service layer",
  indexes: [index("masterdash_control_requests_created_at_idx", ["created_at"])],
  columns: [
    { name: "request_id", type: "uuid", nn: true, note: "application-generated UUID primary key" },
    { name: "system_id", type: "text", nn: true },
    { name: "action", type: "text", nn: true },
    { name: "requested_at", type: "timestamptz", nn: true },
    { name: "body_sha256", type: "text", nn: true },
    { name: "status", type: "text", nn: true },
    { name: "response_status", type: "integer" },
    { name: "response_message", type: "text" },
    { name: "created_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
    { name: "completed_at", type: "timestamptz" },
  ],
};
const masterdashSsoJtis: TableSpec = {
  name: "masterdash_sso_jtis",
  database: "worldcons_ops",
  primaryKey: ["jti_hash"],
  note: "the system_id = 'worldcons' inline check stays in the service layer",
  indexes: [index("masterdash_sso_jtis_expires_at_idx", ["expires_at"])],
  columns: [
    { name: "jti_hash", type: "text", nn: true, note: "hashed JWT id primary key (no token material stored)" },
    { name: "system_id", type: "text", nn: true },
    { name: "expires_at", type: "timestamptz", nn: true },
    { name: "created_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
  ],
};
const opsWorkflowHeartbeats: TableSpec = {
  name: "ops_workflow_heartbeats",
  database: "worldcons_ops",
  primaryKey: ["workflow_key"],
  note: "the key/run-id/detail checks stay in the service layer",
  columns: [
    { name: "workflow_key", type: "text", nn: true },
    { name: "last_started_at", type: "timestamptz", nn: true },
    { name: "last_completed_at", type: "timestamptz" },
    { name: "last_status", type: "text", nn: true, enum: WORKFLOW_HEARTBEAT_STATUS_VALUES },
    { name: "run_id", type: "text" },
    { name: "detail", type: "jsonb", nn: true, def: "'{}'" },
    { name: "updated_at", type: "timestamptz", nn: true, note: "application-generated UTC ISO-8601" },
  ],
};
const securityRateLimitBucketsV1: TableSpec = {
  name: "security_rate_limit_buckets_v1",
  database: "worldcons_ops",
  primaryKey: ["profile", "identifier_hash"],
  note: "the profile/identifier/count checks stay in the service layer; hot rate limiting may move to Cloudflare-native controls (plan 5.3 / 12)",
  indexes: [index("security_rate_limit_buckets_v1_reset_idx", ["reset_at"])],
  columns: [
    { name: "profile", type: "text", nn: true },
    { name: "identifier_hash", type: "text", nn: true, note: "hashed client identifier only" },
    { name: "request_count", type: "integer", nn: true, def: "0" },
    { name: "reset_at", type: "timestamptz", nn: true },
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
  adminCommandAttempts,
  adminCommandEvents,
  adminCommandRuns,
  adminCommands,
  adminCompatibilityObservationsP5,
  adminGovernanceEvidenceP5,
  adminOpsEvents,
  adminRetentionHoldsP5,
  masterdashCollectionControl,
  masterdashControlRequests,
  masterdashSsoJtis,
  opsWorkflowHeartbeats,
  securityRateLimitBucketsV1,
].map(buildTable);
