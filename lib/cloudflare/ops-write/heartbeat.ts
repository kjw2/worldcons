import {
  WORKFLOW_HEARTBEAT_STATUS_VALUES,
} from "@/lib/cloudflare/d1/schema/worldcons-ops";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";

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
export const M11_OPS_HEARTBEAT_CANARY_RUN_ID = "m11-ops-heartbeat-canary";
export const OPS_HEARTBEAT_BOUNDARY_PATH = "/v1/ops/heartbeat";
export const OPS_HEARTBEAT_BOUNDARY_SEARCH_PATH = "/internal/ops-heartbeat/write";

export type OpsHeartbeatWriteAuthority = "supabase" | "d1-canary" | "d1";

export interface OpsHeartbeatWriteAuthorityConfig {
  authority: OpsHeartbeatWriteAuthority;
}

export interface OpsHeartbeatWriteAuthorityEnvironment {
  [key: string]: string | undefined;
}

export type OpsHeartbeatStatus = (typeof WORKFLOW_HEARTBEAT_STATUS_VALUES)[number];

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
  const raw = environment[OPS_HEARTBEAT_WRITE_AUTHORITY_ENV]?.trim().toLowerCase();
  if (raw === "d1" || raw === "d1-canary") return { authority: raw };
  return { authority: "supabase" };
}

export function shouldWriteOpsHeartbeatToD1(
  row: Pick<OpsHeartbeatWriteRow, "run_id" | "detail">,
  config: OpsHeartbeatWriteAuthorityConfig,
) {
  if (config.authority === "d1") return true;
  if (config.authority !== "d1-canary") return false;
  return row.run_id === M11_OPS_HEARTBEAT_CANARY_RUN_ID;
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
