import {
  WORKFLOW_HEARTBEAT_STATUS_VALUES,
} from "@/lib/cloudflare/d1/schema/worldcons-ops";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { m13ProfileValueForEnvVar } from "@/lib/cloudflare/m13/profile-override";

/**
 * M11.3 ops-heartbeat Cloudflare boundary contract.
 *
 * `ops_workflow_heartbeats` is owned by Node/GitHub callers (`scripts/*`,
 * GitHub Actions, the Vercel fallback route) that run the `ops_workflow_heartbeat_v1`
 * Postgres RPC. Those callers cannot use a Worker Service Binding, so this
 * contract is the single, runtime-neutral surface shared by:
 *
 * - the publicly reachable, bearer-authenticated `worldcons-ops-write` Worker
 *   that GitHub/Node call over HTTPS at its workers.dev endpoint;
 * - the Node/GitHub client seam;
 * - the internal Supabase compatibility bridge on `worldcons-search`;
 * - the focused tests.
 *
 * It is deliberately free of `node:*` and `next/*` imports so it can be bundled
 * into a Worker and imported by the Node caller.
 */

export const OPS_HEARTBEAT_WRITE_AUTHORITY_ENV = "WORLDCONS_OPS_HEARTBEAT_WRITE_AUTHORITY";
/**
 * M11.3 live-canary marker. A real GitHub/Node heartbeat derives its `run_id`
 * from `GITHUB_RUN_ID` and cannot be forced to the fixed
 * `M11_OPS_HEARTBEAT_CANARY_RUN_ID` literal, so the `d1-canary` selector would
 * never select a real admin-watchdog run. When this env var is set, the Node
 * writer adds an explicit, bounded `detail.m11OpsHeartbeatCanary = true` marker
 * (leaving `run_id` as the exact GitHub run id), and the boundary's
 * `d1-canary` selector accepts that marker. The marker is only wired into the
 * one deliberately dispatched canary job, so ordinary runs are never selected.
 */
export const OPS_HEARTBEAT_CANARY_MARKER_ENV = "WORLDCONS_OPS_HEARTBEAT_CANARY_MARKER";
/** Bounded detail key that marks one heartbeat as the deliberate D1 canary. */
export const OPS_HEARTBEAT_CANARY_DETAIL_KEY = "m11OpsHeartbeatCanary";
/**
 * M11.3R read-authority seam. Reads resolve independently of writes so a
 * staging write canary never silently changes what a reader sees. The default
 * `supabase` preserves the resting reader behavior; `d1` selects the migrated
 * `worldcons_ops` read and fails closed if it is unavailable. There is
 * deliberately no `d1-canary` read mode: a partial read is not meaningful.
 */
export const OPS_HEARTBEAT_READ_AUTHORITY_ENV = "WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY";
export const M11_OPS_HEARTBEAT_CANARY_RUN_ID = "m11-ops-heartbeat-canary";
export const OPS_HEARTBEAT_BOUNDARY_PATH = "/v1/ops/heartbeat";
export const OPS_HEARTBEAT_BOUNDARY_READ_PATH = "/v1/ops/heartbeats";
export const OPS_HEARTBEAT_BOUNDARY_SEARCH_PATH = "/internal/ops-heartbeat/write";

export type OpsHeartbeatWriteAuthority = "supabase" | "d1-canary" | "d1";
export type OpsHeartbeatReadAuthority = "supabase" | "d1";

export interface OpsHeartbeatWriteAuthorityConfig {
  authority: OpsHeartbeatWriteAuthority;
}

export interface OpsHeartbeatReadAuthorityConfig {
  authority: OpsHeartbeatReadAuthority;
}

export interface OpsHeartbeatWriteAuthorityEnvironment {
  [key: string]: string | undefined;
}

export type OpsHeartbeatStatus = (typeof WORKFLOW_HEARTBEAT_STATUS_VALUES)[number];

/**
 * The canonical heartbeat workflow keys. Owned here (the runtime-neutral
 * boundary contract) so the Worker, the Node read/write seams and the D1 read
 * all agree without importing `lib/ops/workflow-heartbeat.ts` (which pulls in
 * Node/Next modules).
 */
export const OPS_HEARTBEAT_WORKFLOW_KEYS = [
  "collection",
  "summary",
  "embedding",
  "watchdog",
  "catalog_backfill",
] as const;
export type OpsHeartbeatWorkflowKey = (typeof OPS_HEARTBEAT_WORKFLOW_KEYS)[number];

/** One bounded heartbeat row, shared by the D1 read, the boundary and the Node reader. */
export interface OpsHeartbeatReadRecord {
  workflowKey: OpsHeartbeatWorkflowKey;
  lastStartedAt: string;
  lastCompletedAt: string | null;
  lastStatus: OpsHeartbeatStatus;
  runId: string | null;
}

export const OPS_HEARTBEAT_STATUS_VALUES = WORKFLOW_HEARTBEAT_STATUS_VALUES;
export const OPS_HEARTBEAT_MAX_DETAIL_BYTES = 8192;
export const OPS_HEARTBEAT_MAX_RUN_ID_LENGTH = 160;
const OPS_HEARTBEAT_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/u;

export interface OpsHeartbeatWriteRow {
  workflow_key: string;
  status: OpsHeartbeatStatus;
  run_id: string | null;
  detail: Record<string, unknown>;
  observed_at: string;
}

export type OpsHeartbeatWriteRowParseResult =
  | { ok: true; row: OpsHeartbeatWriteRow }
  | { ok: false; error: string };

export function resolveOpsHeartbeatWriteAuthorityConfig(
  environment: OpsHeartbeatWriteAuthorityEnvironment = {},
): OpsHeartbeatWriteAuthorityConfig {
  if (m13ProfileValueForEnvVar(OPS_HEARTBEAT_WRITE_AUTHORITY_ENV, environment) === "d1") return { authority: "d1" };
  const raw = environment[OPS_HEARTBEAT_WRITE_AUTHORITY_ENV]?.trim().toLowerCase();
  if (raw === "d1-canary") return { authority: raw };
  return { authority: "d1" };
}

/**
 * Resolves whether one real Node/GitHub heartbeat is the deliberate D1 canary.
 *
 * Returns `true` only when `OPS_HEARTBEAT_CANARY_MARKER_ENV` is set to the
 * literal `true`/`1` (a brief canary window) or exactly equals the caller's
 * derived `run_id` (an exact, single-run pin). Any other value — including an
 * empty/missing var — is `false`, so an ordinary run is never marked.
 */
export function resolveOpsHeartbeatCanaryMarker(
  environment: OpsHeartbeatWriteAuthorityEnvironment,
  runId: string,
): boolean {
  const raw = environment[OPS_HEARTBEAT_CANARY_MARKER_ENV]?.trim();
  if (!raw) return false;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  return raw === runId;
}

export function shouldWriteOpsHeartbeatToD1(
  row: Pick<OpsHeartbeatWriteRow, "run_id" | "detail">,
  config: OpsHeartbeatWriteAuthorityConfig,
) {
  if (config.authority === "d1") return true;
  if (config.authority !== "d1-canary") return false;
  // Two disjoint, caller-controlled ways to select exactly one canary heartbeat:
  // the legacy fixed run-id literal, or the explicit detail marker a real
  // GitHub/Node canary run emits under OPS_HEARTBEAT_CANARY_MARKER_ENV. Both
  // leave `run_id` free to be the real GitHub run id. Ordinary heartbeats never
  // carry either, so no ordinary or later run is selected.
  if (row.run_id === M11_OPS_HEARTBEAT_CANARY_RUN_ID) return true;
  return row.detail[OPS_HEARTBEAT_CANARY_DETAIL_KEY] === true;
}

/**
 * Resolves the read authority. D1 is permanent after M13, so missing or
 * unrecognized values stay on D1 instead of reopening the retired backend.
 */
export function resolveOpsHeartbeatReadAuthorityConfig(
  environment: OpsHeartbeatWriteAuthorityEnvironment = {},
): OpsHeartbeatReadAuthorityConfig {
  if (m13ProfileValueForEnvVar(OPS_HEARTBEAT_READ_AUTHORITY_ENV, environment) === "d1") return { authority: "d1" };
  const raw = environment[OPS_HEARTBEAT_READ_AUTHORITY_ENV]?.trim().toLowerCase();
  return { authority: "d1" };
}

export function shouldReadOpsHeartbeatFromD1(
  config: OpsHeartbeatReadAuthorityConfig,
) {
  return config.authority === "d1";
}

interface OpsHeartbeatReadAuthorityGlobal {
  __worldconsOpsHeartbeatReadAuthorityV1?: OpsHeartbeatReadAuthorityConfig;
}

function runtimeGlobal(): typeof globalThis & OpsHeartbeatReadAuthorityGlobal {
  return globalThis as typeof globalThis & OpsHeartbeatReadAuthorityGlobal;
}

/**
 * Stores the read authority resolved from the Worker `env` so runtime code can
 * select `d1` without importing the Worker entry. Mirrors the M11 write/shadow
 * runtime slots. A `null` value clears the slot.
 */
export function setRuntimeOpsHeartbeatReadAuthorityConfig(
  config: OpsHeartbeatReadAuthorityConfig | null,
) {
  const target = runtimeGlobal();
  if (config) target.__worldconsOpsHeartbeatReadAuthorityV1 = config;
  else delete target.__worldconsOpsHeartbeatReadAuthorityV1;
}

export function getRuntimeOpsHeartbeatReadAuthorityConfig(): OpsHeartbeatReadAuthorityConfig | null {
  return runtimeGlobal().__worldconsOpsHeartbeatReadAuthorityV1 ?? null;
}

/**
 * Resolves the read authority for the current runtime. The Worker-entry runtime
 * slot (set from `env`) wins when present; otherwise the process environment is
 * consulted. This lets the Cloudflare masterdash route honor its `env` var while
 * the same code in a Node/GitHub process honors `process.env`.
 */
export function resolveEffectiveOpsHeartbeatReadAuthorityConfig(
  environment: OpsHeartbeatWriteAuthorityEnvironment = {},
): OpsHeartbeatReadAuthorityConfig {
  return getRuntimeOpsHeartbeatReadAuthorityConfig() ?? resolveOpsHeartbeatReadAuthorityConfig(environment);
}

const OPS_HEARTBEAT_READ_STATUS_SET = new Set<string>(OPS_HEARTBEAT_STATUS_VALUES);
const OPS_HEARTBEAT_READ_KEY_SET = new Set<string>(OPS_HEARTBEAT_WORKFLOW_KEYS);

/**
 * Maps one raw D1 row to the same record shape the Supabase reader returns.
 * Returns `null` for a row that cannot be represented (unknown key, missing
 * start timestamp or invalid status), matching the Supabase reader's defensive
 * row filter. The `detail` and `updated_at` columns are never selected.
 */
export function parseOpsHeartbeatReadRow(row: Record<string, unknown>): OpsHeartbeatReadRecord | null {
  const workflowKey = row.workflow_key;
  if (typeof workflowKey !== "string" || !OPS_HEARTBEAT_READ_KEY_SET.has(workflowKey)) return null;
  const lastStartedAt = row.last_started_at;
  if (typeof lastStartedAt !== "string" || lastStartedAt.length === 0) return null;
  const lastStatus = row.last_status;
  if (typeof lastStatus !== "string" || !OPS_HEARTBEAT_READ_STATUS_SET.has(lastStatus)) return null;
  const lastCompletedAt = row.last_completed_at;
  const runId = row.run_id;
  return {
    workflowKey: workflowKey as OpsHeartbeatWorkflowKey,
    lastStartedAt,
    lastCompletedAt: typeof lastCompletedAt === "string" ? lastCompletedAt : null,
    lastStatus: lastStatus as OpsHeartbeatStatus,
    runId: typeof runId === "string" ? runId : null,
  };
}

/**
 * Validates one already-mapped heartbeat record (the boundary's JSON
 * `heartbeats` array element shape) before the Node reader trusts it. Returns
 * `null` for an unrepresentable entry, so a malformed boundary body can never be
 * surfaced as a valid heartbeat.
 */
export function parseOpsHeartbeatReadRecord(value: unknown): OpsHeartbeatReadRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const workflowKey = record.workflowKey;
  if (typeof workflowKey !== "string" || !OPS_HEARTBEAT_READ_KEY_SET.has(workflowKey)) return null;
  const lastStartedAt = record.lastStartedAt;
  if (typeof lastStartedAt !== "string" || lastStartedAt.length === 0) return null;
  const lastStatus = record.lastStatus;
  if (typeof lastStatus !== "string" || !OPS_HEARTBEAT_READ_STATUS_SET.has(lastStatus)) return null;
  const lastCompletedAt = record.lastCompletedAt;
  const runId = record.runId;
  return {
    workflowKey: workflowKey as OpsHeartbeatWorkflowKey,
    lastStartedAt,
    lastCompletedAt: typeof lastCompletedAt === "string" ? lastCompletedAt : null,
    lastStatus: lastStatus as OpsHeartbeatStatus,
    runId: typeof runId === "string" ? runId : null,
  };
}

/**
 * M11.3R read-only D1 heartbeat projection.
 *
 * Selects exactly the columns the Supabase reader projects, for the authored
 * `OPS_HEARTBEAT_WORKFLOW_KEYS`, in one parameterized `IN (?, ...)` statement.
 * No caller value enters SQL text. A malformed envelope or a non-object row
 * fails closed (throws) rather than returning a silently shorter list, so a
 * selected D1 read authority can never be mistaken for "no heartbeats".
 */
export async function readOpsHeartbeatsFromD1(
  binding: D1RuntimeDatabase,
): Promise<OpsHeartbeatReadRecord[]> {
  const placeholders = OPS_HEARTBEAT_WORKFLOW_KEYS.map(() => "?").join(", ");
  const statement = binding.prepare(
    "SELECT workflow_key, last_started_at, last_completed_at, last_status, run_id "
    + `FROM ops_workflow_heartbeats WHERE workflow_key IN (${placeholders})`,
  );
  const bound = statement.bind(...OPS_HEARTBEAT_WORKFLOW_KEYS);
  if (typeof bound.all !== "function") throw new Error("ops_heartbeat_d1_read.run_unavailable");
  const result = await bound.all<Record<string, unknown>>();
  if (result === null || typeof result !== "object") throw new Error("ops_heartbeat_d1_read.invalid_response");
  if (result.success === false) throw new Error("ops_heartbeat_d1_read.query_failed");
  if (!Array.isArray(result.results)) throw new Error("ops_heartbeat_d1_read.invalid_response");
  return result.results.flatMap((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("ops_heartbeat_d1_read.invalid_response");
    }
    const parsed = parseOpsHeartbeatReadRow(row as Record<string, unknown>);
    return parsed ? [parsed] : [];
  });
}

function boundedString(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  return value.length > max ? undefined : value;
}

function encodedByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates an inbound boundary body with the same service-layer gates as the
 * `ops_workflow_heartbeat_v1` RPC (key pattern, status enum, run-id length,
 * detail size bound, observed timestamp). The returned error code is bounded and
 * never echoes caller input.
 */
export function parseOpsHeartbeatWriteRow(input: unknown): OpsHeartbeatWriteRowParseResult {
  if (!isRecord(input)) return { ok: false, error: "invalid_body" };

  const workflowKey = input.workflow_key;
  if (typeof workflowKey !== "string" || !OPS_HEARTBEAT_KEY_PATTERN.test(workflowKey)) {
    return { ok: false, error: "invalid_workflow_key" };
  }

  const status = input.status;
  if (typeof status !== "string" || !OPS_HEARTBEAT_STATUS_VALUES.includes(status as OpsHeartbeatStatus)) {
    return { ok: false, error: "invalid_status" };
  }

  const runId = boundedString(input.run_id, OPS_HEARTBEAT_MAX_RUN_ID_LENGTH);
  if (runId === undefined) return { ok: false, error: "invalid_run_id" };

  const detail = input.detail === undefined ? {} : input.detail;
  if (!isRecord(detail)) return { ok: false, error: "invalid_detail" };
  if (encodedByteLength(JSON.stringify(detail)) > OPS_HEARTBEAT_MAX_DETAIL_BYTES) {
    return { ok: false, error: "detail_too_large" };
  }

  const observedAt = input.observed_at;
  if (typeof observedAt !== "string" || observedAt.length > 64 || !Number.isFinite(Date.parse(observedAt))) {
    return { ok: false, error: "invalid_observed_at" };
  }

  return {
    ok: true,
    row: {
      workflow_key: workflowKey,
      status: status as OpsHeartbeatStatus,
      run_id: runId === null ? null : (runId.trim() || null),
      detail,
      observed_at: observedAt,
    },
  };
}

/**
 * Parameterized upsert that reproduces the `ops_workflow_heartbeat_v1` RPC
 * semantics exactly (including the running-vs-terminal timestamp carry and
 * `nullif(trim(run_id), '')`). No caller value enters SQL text.
 */
export async function runOpsHeartbeatUpsertD1(
  binding: D1RuntimeDatabase,
  row: OpsHeartbeatWriteRow,
) {
  const statement = binding.prepare([
    "INSERT INTO ops_workflow_heartbeats (",
    "workflow_key, last_started_at, last_completed_at, last_status, run_id, detail, updated_at",
    ") VALUES (?, ?, ?, ?, ?, ?, ?)",
    "ON CONFLICT (workflow_key) DO UPDATE SET",
    "last_started_at = CASE WHEN excluded.last_status = 'running'",
    "THEN excluded.last_started_at ELSE ops_workflow_heartbeats.last_started_at END,",
    "last_completed_at = CASE WHEN excluded.last_status = 'running'",
    "THEN ops_workflow_heartbeats.last_completed_at ELSE excluded.last_completed_at END,",
    "last_status = excluded.last_status,",
    "run_id = excluded.run_id,",
    "detail = excluded.detail,",
    "updated_at = excluded.updated_at",
  ].join(" "));
  const bound = statement.bind(
    row.workflow_key,
    row.observed_at,
    row.status === "running" ? null : row.observed_at,
    row.status,
    row.run_id,
    JSON.stringify(row.detail),
    row.observed_at,
  );
  if (!bound.run) throw new Error("ops_heartbeat_d1_authority.run_unavailable");
  const result = await bound.run();
  if (result.success === false || result.error) {
    throw new Error("ops_heartbeat_d1_authority.write_failed");
  }
  if (result.meta?.changes !== 1) {
    throw new Error("ops_heartbeat_d1_authority.unexpected_changes");
  }
  return { workflowKey: row.workflow_key, observedAt: row.observed_at };
}
