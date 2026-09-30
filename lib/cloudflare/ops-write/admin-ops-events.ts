import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { m13ProfileValueForEnvVar } from "@/lib/cloudflare/m13/profile-override";

/**
 * M11.4 admin_ops_events Cloudflare boundary contract.
 *
 * `worldcons_ops.admin_ops_events` is Cloudflare/D1-owned. Manual/local callers
 * cannot use a Worker Service Binding, so this contract is the single,
 * runtime-neutral compatibility surface shared by:
 *
 * - the publicly reachable, bearer-authenticated `/v1/ops/*` boundary;
 * - the Node/operator client seam (`admin-ops-events-client.ts`);
 * - the focused tests.
 *
 * Unlike the M11.3 append-only heartbeat, this surface must preserve the
 * watchdog writer's full contract: one bounded insert, a read-before-write
 * dedupe read of the latest event (`detail.signature`), the 30-day prune, and
 * the descending `created_at` limit projection the admin ops page consumes.
 *
 * It is deliberately free of `node:*` and `next/*` imports so it can be bundled
 * into a Worker and imported by the Node caller.
 */

export const ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV = "WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY";
/**
 * The dedupe read is part of the write transaction, so it follows the write
 * authority. The admin list projection is a reader concern and resolves
 * independently, exactly as M11.3R separated the heartbeat read authority. The
 * default `supabase` preserves the resting reader behavior; `d1` selects the
 * migrated `worldcons_ops` list and fails closed if it is unavailable. There is
 * deliberately no `d1-canary` read mode: a partial read is not meaningful.
 */
export const ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV = "WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY";
/**
 * M11.4 live-canary marker. `admin_ops_events` has no run-id column and its
 * `event_type`/`severity` enum is fixed by the Postgres check constraint (which
 * cannot be edited), so the bounded selector is an explicit `detail` marker.
 * When this env var is `true`/`1` the Node writer adds
 * `detail.m11AdminOpsEventsCanary = true` for every event written during the
 * deliberate canary window, and the boundary's `d1-canary` selector accepts only
 * a row carrying that exact marker. Ordinary runs never carry it.
 */
export const ADMIN_OPS_EVENTS_CANARY_MARKER_ENV = "WORLDCONS_ADMIN_OPS_EVENTS_CANARY_MARKER";
export const ADMIN_OPS_EVENTS_CANARY_DETAIL_KEY = "m11AdminOpsEventsCanary";

export const ADMIN_OPS_EVENTS_BOUNDARY_PATH = "/v1/ops/admin-events";
export const ADMIN_OPS_EVENTS_BOUNDARY_LATEST_PATH = "/v1/ops/admin-events/latest";
export const ADMIN_OPS_EVENTS_BOUNDARY_LIST_PATH = "/v1/ops/admin-events/list";
export const ADMIN_OPS_EVENTS_BOUNDARY_PRUNE_PATH = "/v1/ops/admin-events/prune";
export const ADMIN_OPS_EVENTS_SEARCH_PATH = "/internal/admin-ops-events";
export const ADMIN_OPS_EVENTS_SEARCH_LATEST_PATH = "/internal/admin-ops-events/latest";
export const ADMIN_OPS_EVENTS_SEARCH_PRUNE_PATH = "/internal/admin-ops-events/prune";

/**
 * Mirrors the `admin_ops_events_event_type_check` values from
 * `supabase/migrations/20260829120000_admin_ops_watchdog.sql`. Kept here (the
 * runtime-neutral boundary contract) rather than in the D1 schema because the
 * original scan did not capture the inline value checks as table constraints.
 */
export const ADMIN_OPS_EVENT_TYPE_VALUES = [
  "watchdog_ok",
  "watchdog_violation",
  "watchdog_compensation",
  "watchdog_issue_filed",
  "watchdog_issue_updated",
  "watchdog_issue_closed",
  "watchdog_error",
] as const;
export type AdminOpsEventType = (typeof ADMIN_OPS_EVENT_TYPE_VALUES)[number];

/** Mirrors the `admin_ops_events_severity_check` values. */
export const ADMIN_OPS_SEVERITY_VALUES = ["info", "warning", "critical"] as const;
export type AdminOpsEventSeverity = (typeof ADMIN_OPS_SEVERITY_VALUES)[number];

/** Authoritative retention window for the prune step (mirrors `OPS_EVENT_RETENTION_DAYS`). */
export const ADMIN_OPS_EVENTS_RETENTION_DAYS = 30;
/** The admin page asks for 20; the boundary accepts at most this many. */
export const ADMIN_OPS_EVENTS_DEFAULT_LIST_LIMIT = 20;
export const ADMIN_OPS_EVENTS_MAX_LIST_LIMIT = 100;
export const ADMIN_OPS_EVENTS_MAX_SUMMARY_LENGTH = 8192;
export const ADMIN_OPS_EVENTS_MAX_DETAIL_BYTES = 65_536;
export const ADMIN_OPS_EVENTS_MAX_SOURCE_KEY_LENGTH = 120;

export type AdminOpsEventsWriteAuthority = "supabase" | "d1-canary" | "d1";
export type AdminOpsEventsReadAuthority = "supabase" | "d1";

export interface AdminOpsEventsWriteAuthorityConfig {
  authority: AdminOpsEventsWriteAuthority;
}

export interface AdminOpsEventsReadAuthorityConfig {
  authority: AdminOpsEventsReadAuthority;
}

export interface AdminOpsEventsEnvironment {
  [key: string]: string | undefined;
}

/** One bounded event to append, shared by the D1 insert, the boundary and the Node client. */
export interface AdminOpsEventWriteRow {
  event_type: AdminOpsEventType;
  severity: AdminOpsEventSeverity;
  source_key: string | null;
  summary: string;
  detail: Record<string, unknown>;
  created_at: string;
}

/** The projection the admin ops page reads, matching `AdminOpsEvent` in `lib/ops/watchdog.ts`. */
export interface AdminOpsEventRecord {
  id: string;
  event_type: AdminOpsEventType;
  severity: AdminOpsEventSeverity;
  source_key: string | null;
  summary: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export type AdminOpsEventWriteRowParseResult =
  | { ok: true; row: AdminOpsEventWriteRow }
  | { ok: false; error: string };

export function resolveAdminOpsEventsWriteAuthorityConfig(
  environment: AdminOpsEventsEnvironment = {},
): AdminOpsEventsWriteAuthorityConfig {
  if (m13ProfileValueForEnvVar(ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV, environment) === "d1") return { authority: "d1" };
  const raw = environment[ADMIN_OPS_EVENTS_WRITE_AUTHORITY_ENV]?.trim().toLowerCase();
  if (raw === "d1-canary") return { authority: raw };
  return { authority: "d1" };
}

/**
 * Resolves the read authority. D1 is permanent after M13, so missing or
 * unrecognized values stay on D1 instead of reopening the retired backend.
 */
export function resolveAdminOpsEventsReadAuthorityConfig(
  environment: AdminOpsEventsEnvironment = {},
): AdminOpsEventsReadAuthorityConfig {
  if (m13ProfileValueForEnvVar(ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV, environment) === "d1") return { authority: "d1" };
  const raw = environment[ADMIN_OPS_EVENTS_READ_AUTHORITY_ENV]?.trim().toLowerCase();
  return { authority: "d1" };
}

export function shouldReadAdminOpsEventsFromD1(config: AdminOpsEventsReadAuthorityConfig): boolean {
  return config.authority === "d1";
}

/**
 * Returns `true` only when the bounded canary marker env var is the literal
 * `true`/`1`. Any other value — including empty/missing — is `false`, so an
 * ordinary run is never marked.
 */
export function resolveAdminOpsEventsCanaryMarker(environment: AdminOpsEventsEnvironment): boolean {
  const raw = environment[ADMIN_OPS_EVENTS_CANARY_MARKER_ENV]?.trim();
  return raw === "1" || raw?.toLowerCase() === "true";
}

/**
 * The boundary's defense-in-depth canary selector, mirroring
 * `shouldWriteOpsHeartbeatToD1`. `d1` selects every event; `d1-canary` selects
 * only an event carrying the exact `detail.m11AdminOpsEventsCanary === true`
 * marker; `supabase` selects none. The marker must be exactly `true`, not a
 * truthy string, so an ordinary event is never selected.
 */
export function shouldWriteAdminOpsEventToD1(
  row: Pick<AdminOpsEventWriteRow, "detail">,
  config: AdminOpsEventsWriteAuthorityConfig,
): boolean {
  if (config.authority === "d1") return true;
  if (config.authority !== "d1-canary") return false;
  return row.detail[ADMIN_OPS_EVENTS_CANARY_DETAIL_KEY] === true;
}

interface AdminOpsEventsRuntimeGlobal {
  __worldconsAdminOpsEventsReadAuthorityV1?: AdminOpsEventsReadAuthorityConfig;
  __worldconsAdminOpsEventsWriteAuthorityV1?: AdminOpsEventsWriteAuthorityConfig;
}

function runtimeGlobal(): typeof globalThis & AdminOpsEventsRuntimeGlobal {
  return globalThis as typeof globalThis & AdminOpsEventsRuntimeGlobal;
}

/**
 * Stores the read authority resolved from the Worker `env` so runtime code can
 * select `d1` without importing the Worker entry. Mirrors the M11.3R heartbeat
 * read runtime slot. A `null` value clears the slot.
 */
export function setRuntimeAdminOpsEventsReadAuthorityConfig(
  config: AdminOpsEventsReadAuthorityConfig | null,
) {
  const target = runtimeGlobal();
  if (config) target.__worldconsAdminOpsEventsReadAuthorityV1 = config;
  else delete target.__worldconsAdminOpsEventsReadAuthorityV1;
}

export function getRuntimeAdminOpsEventsReadAuthorityConfig(): AdminOpsEventsReadAuthorityConfig | null {
  return runtimeGlobal().__worldconsAdminOpsEventsReadAuthorityV1 ?? null;
}

export function resolveEffectiveAdminOpsEventsReadAuthorityConfig(
  environment: AdminOpsEventsEnvironment = {},
): AdminOpsEventsReadAuthorityConfig {
  return getRuntimeAdminOpsEventsReadAuthorityConfig() ?? resolveAdminOpsEventsReadAuthorityConfig(environment);
}

/**
 * Stores the write authority resolved from the Worker `env` so the Cloudflare
 * runtime honors its own var while a Node/GitHub process falls back to
 * `process.env`. A `null` value clears the slot.
 */
export function setRuntimeAdminOpsEventsWriteAuthorityConfig(
  config: AdminOpsEventsWriteAuthorityConfig | null,
) {
  const target = runtimeGlobal();
  if (config) target.__worldconsAdminOpsEventsWriteAuthorityV1 = config;
  else delete target.__worldconsAdminOpsEventsWriteAuthorityV1;
}

export function getRuntimeAdminOpsEventsWriteAuthorityConfig(): AdminOpsEventsWriteAuthorityConfig | null {
  return runtimeGlobal().__worldconsAdminOpsEventsWriteAuthorityV1 ?? null;
}

export function resolveEffectiveAdminOpsEventsWriteAuthorityConfig(
  environment: AdminOpsEventsEnvironment = {},
): AdminOpsEventsWriteAuthorityConfig {
  return getRuntimeAdminOpsEventsWriteAuthorityConfig() ?? resolveAdminOpsEventsWriteAuthorityConfig(environment);
}

/**
 * Resolves whether the write contract (insert, dedupe read, prune) should target
 * D1 for the current runtime. `d1` always does; `d1-canary` does only while the
 * bounded marker is active; `supabase` (and typos) never does.
 */
export function shouldWriteAdminOpsEventsToD1(
  environment: AdminOpsEventsEnvironment = {},
): boolean {
  const config = resolveEffectiveAdminOpsEventsWriteAuthorityConfig(environment);
  if (config.authority === "d1") return true;
  if (config.authority !== "d1-canary") return false;
  return resolveAdminOpsEventsCanaryMarker(environment);
}

const ADMIN_OPS_EVENT_TYPE_SET = new Set<string>(ADMIN_OPS_EVENT_TYPE_VALUES);
const ADMIN_OPS_SEVERITY_SET = new Set<string>(ADMIN_OPS_SEVERITY_VALUES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodedByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Validates an inbound boundary body with the same service-layer gates the
 * watchdog writer applies (event-type/severity enum, summary/source bounds,
 * detail size, created timestamp). The returned error code is bounded and never
 * echoes caller input.
 */
export function parseAdminOpsEventWriteRow(input: unknown): AdminOpsEventWriteRowParseResult {
  if (!isRecord(input)) return { ok: false, error: "invalid_body" };

  const eventType = input.event_type;
  if (typeof eventType !== "string" || !ADMIN_OPS_EVENT_TYPE_SET.has(eventType)) {
    return { ok: false, error: "invalid_event_type" };
  }

  const severity = input.severity;
  if (typeof severity !== "string" || !ADMIN_OPS_SEVERITY_SET.has(severity)) {
    return { ok: false, error: "invalid_severity" };
  }

  const summary = input.summary;
  if (typeof summary !== "string" || summary.length === 0 || summary.length > ADMIN_OPS_EVENTS_MAX_SUMMARY_LENGTH) {
    return { ok: false, error: "invalid_summary" };
  }

  const rawSourceKey = input.source_key;
  if (rawSourceKey !== null && rawSourceKey !== undefined && typeof rawSourceKey !== "string") {
    return { ok: false, error: "invalid_source_key" };
  }
  const sourceKey = typeof rawSourceKey === "string" && rawSourceKey.length > 0 ? rawSourceKey : null;
  if (sourceKey !== null && sourceKey.length > ADMIN_OPS_EVENTS_MAX_SOURCE_KEY_LENGTH) {
    return { ok: false, error: "invalid_source_key" };
  }

  const detail = input.detail === undefined || input.detail === null ? {} : input.detail;
  if (!isRecord(detail)) return { ok: false, error: "invalid_detail" };
  if (encodedByteLength(JSON.stringify(detail)) > ADMIN_OPS_EVENTS_MAX_DETAIL_BYTES) {
    return { ok: false, error: "detail_too_large" };
  }

  const createdAt = input.created_at;
  if (typeof createdAt !== "string" || createdAt.length > 64 || !Number.isFinite(Date.parse(createdAt))) {
    return { ok: false, error: "invalid_created_at" };
  }

  return {
    ok: true,
    row: {
      event_type: eventType as AdminOpsEventType,
      severity: severity as AdminOpsEventSeverity,
      source_key: sourceKey,
      summary,
      detail,
      created_at: createdAt,
    },
  };
}

/**
 * Maps one raw D1 row to the same record shape the Supabase reader returns.
 * Returns `null` for a row that cannot be represented (unknown event type or
 * severity, missing id/summary/created timestamp), matching the Supabase
 * reader's defensive row filter.
 */
export function parseAdminOpsEventReadRow(row: Record<string, unknown>): AdminOpsEventRecord | null {
  const id = row.id;
  if (typeof id !== "string" || id.length === 0) return null;
  const eventType = row.event_type;
  if (typeof eventType !== "string" || !ADMIN_OPS_EVENT_TYPE_SET.has(eventType)) return null;
  const severity = row.severity;
  if (typeof severity !== "string" || !ADMIN_OPS_SEVERITY_SET.has(severity)) return null;
  const summary = row.summary;
  if (typeof summary !== "string" || summary.length === 0) return null;
  const createdAt = row.created_at;
  if (typeof createdAt !== "string" || createdAt.length === 0) return null;

  let detail: Record<string, unknown> = {};
  if (isRecord(row.detail)) {
    detail = row.detail;
  } else if (typeof row.detail === "string" && row.detail.length > 0) {
    try {
      const parsed = JSON.parse(row.detail);
      if (isRecord(parsed)) detail = parsed;
    } catch {
      detail = {};
    }
  }

  return {
    id,
    event_type: eventType as AdminOpsEventType,
    severity: severity as AdminOpsEventSeverity,
    source_key: typeof row.source_key === "string" ? row.source_key : null,
    summary,
    detail,
    created_at: createdAt,
  };
}

/**
 * Validates one already-mapped record (the boundary's JSON `events` array
 * element shape) before the Node reader trusts it. Returns `null` for an
 * unrepresentable entry, so a malformed boundary body can never be surfaced as
 * a valid event.
 */
export function parseAdminOpsEventRecord(value: unknown): AdminOpsEventRecord | null {
  if (!isRecord(value)) return null;
  return parseAdminOpsEventReadRow(value);
}

const ADMIN_OPS_EVENTS_COLUMNS = "id, event_type, severity, source_key, summary, detail, created_at";

/**
 * The single bounded insert. `detail` is bound as canonical JSON TEXT; no caller
 * value enters SQL text.
 */
export async function insertAdminOpsEventToD1(
  binding: D1RuntimeDatabase,
  row: AdminOpsEventWriteRow,
  id: string,
): Promise<AdminOpsEventRecord> {
  const statement = binding.prepare(
    "INSERT INTO admin_ops_events (id, event_type, severity, source_key, summary, detail, created_at) "
    + "VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const bound = statement.bind(
    id,
    row.event_type,
    row.severity,
    row.source_key,
    row.summary,
    JSON.stringify(row.detail),
    row.created_at,
  );
  if (!bound.run) throw new Error("admin_ops_events_d1_authority.run_unavailable");
  const result = await bound.run();
  if (result.success === false || result.error) throw new Error("admin_ops_events_d1_authority.write_failed");
  if (result.meta?.changes !== 1) throw new Error("admin_ops_events_d1_authority.unexpected_changes");
  return {
    id,
    event_type: row.event_type,
    severity: row.severity,
    source_key: row.source_key,
    summary: row.summary,
    detail: row.detail,
    created_at: row.created_at,
  };
}

/** The dedupe read: the latest event's signature-bearing projection, bounded to one row. */
export async function readLatestAdminOpsEventFromD1(
  binding: D1RuntimeDatabase,
): Promise<AdminOpsEventRecord | null> {
  const statement = binding.prepare(
    `SELECT ${ADMIN_OPS_EVENTS_COLUMNS} FROM admin_ops_events ORDER BY created_at DESC LIMIT 1`,
  );
  if (typeof statement.all !== "function") throw new Error("admin_ops_events_d1_read.run_unavailable");
  const result = await statement.all<Record<string, unknown>>();
  if (result === null || typeof result !== "object") throw new Error("admin_ops_events_d1_read.invalid_response");
  if (result.success === false) throw new Error("admin_ops_events_d1_read.query_failed");
  if (!Array.isArray(result.results)) throw new Error("admin_ops_events_d1_read.invalid_response");
  if (result.results.length === 0) return null;
  const first = result.results[0];
  if (!isRecord(first)) throw new Error("admin_ops_events_d1_read.invalid_response");
  return parseAdminOpsEventReadRow(first);
}

/** The bounded descending `created_at` projection the admin ops page reads. */
export async function listAdminOpsEventsFromD1(
  binding: D1RuntimeDatabase,
  limit: number,
): Promise<AdminOpsEventRecord[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ADMIN_OPS_EVENTS_MAX_LIST_LIMIT) {
    throw new Error("admin_ops_events_d1_read.invalid_limit");
  }
  const statement = binding.prepare(
    `SELECT ${ADMIN_OPS_EVENTS_COLUMNS} FROM admin_ops_events ORDER BY created_at DESC LIMIT ?`,
  );
  const bound = statement.bind(limit);
  if (typeof bound.all !== "function") throw new Error("admin_ops_events_d1_read.run_unavailable");
  const result = await bound.all<Record<string, unknown>>();
  if (result === null || typeof result !== "object") throw new Error("admin_ops_events_d1_read.invalid_response");
  if (result.success === false) throw new Error("admin_ops_events_d1_read.query_failed");
  if (!Array.isArray(result.results)) throw new Error("admin_ops_events_d1_read.invalid_response");
  return result.results.flatMap((row) => {
    if (!isRecord(row)) throw new Error("admin_ops_events_d1_read.invalid_response");
    const parsed = parseAdminOpsEventReadRow(row);
    return parsed ? [parsed] : [];
  });
}

/**
 * The 30-day retention prune. `cutoff` is an ISO-8601 instant bound as a
 * parameter; no caller value enters SQL text. Returns the number of deleted
 * rows when the D1 driver reports it.
 */
export async function pruneAdminOpsEventsInD1(
  binding: D1RuntimeDatabase,
  cutoff: string,
): Promise<number> {
  if (typeof cutoff !== "string" || cutoff.length === 0 || !Number.isFinite(Date.parse(cutoff))) {
    throw new Error("admin_ops_events_d1_authority.invalid_cutoff");
  }
  const statement = binding.prepare("DELETE FROM admin_ops_events WHERE created_at < ?");
  const bound = statement.bind(cutoff);
  if (!bound.run) throw new Error("admin_ops_events_d1_authority.run_unavailable");
  const result = await bound.run();
  if (result.success === false || result.error) throw new Error("admin_ops_events_d1_authority.prune_failed");
  const changes = result.meta?.changes;
  return typeof changes === "number" ? changes : 0;
}
