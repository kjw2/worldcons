import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import { writeOpsHeartbeatViaBoundary, readOpsHeartbeatsViaBoundary } from "@/lib/cloudflare/ops-write/boundary-client";
import {
  OPS_HEARTBEAT_CANARY_DETAIL_KEY,
  readOpsHeartbeatsFromD1,
  resolveEffectiveOpsHeartbeatReadAuthorityConfig,
  resolveOpsHeartbeatCanaryMarker,
  resolveOpsHeartbeatWriteAuthorityConfig,
  shouldReadOpsHeartbeatFromD1,
} from "@/lib/cloudflare/ops-write/heartbeat";
import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";

export const WORKFLOW_KEYS = ["collection", "summary", "embedding", "watchdog", "catalog_backfill"] as const;
export type WorkflowKey = (typeof WORKFLOW_KEYS)[number];
export type WorkflowHeartbeatStatus = "running" | "success" | "failed" | "deferred";

export interface WorkflowHeartbeatRecord {
  workflowKey: WorkflowKey;
  lastStartedAt: string;
  lastCompletedAt: string | null;
  lastStatus: WorkflowHeartbeatStatus;
  runId: string | null;
}

function runId() {
  return (process.env.GITHUB_RUN_ID || process.env.VERCEL_DEPLOYMENT_ID || `local-${process.pid}`).slice(0, 160);
}

export async function recordWorkflowHeartbeat(
  workflowKey: WorkflowKey,
  status: WorkflowHeartbeatStatus,
  detail: Record<string, unknown> = {},
) {
  const observedAt = new Date().toISOString();
  const workflowRunId = runId();

  // M11.3 live-canary branch. Only when the write authority is explicitly
  // non-resting and the bounded canary marker env var matches this exact run is
  // one `detail` key added, so the boundary's `d1-canary` selector can pick this
  // single run while `run_id` stays the real GitHub run id. Under the resting
  // `supabase` authority (and any non-canary marker value) the detail is byte-for
  // -byte unchanged, so ordinary heartbeats are never marked.
  const writeAuthority = resolveOpsHeartbeatWriteAuthorityConfig(
    process.env as Record<string, string | undefined>,
  );
  const canaryDetail = writeAuthority.authority !== "supabase"
    && resolveOpsHeartbeatCanaryMarker(process.env as Record<string, string | undefined>, workflowRunId)
    ? { ...detail, [OPS_HEARTBEAT_CANARY_DETAIL_KEY]: true }
    : detail;

  // M11.3: when the explicit ops-heartbeat authority is enabled, Node/GitHub
  // callers deliver the heartbeat through the publicly reachable, bearer-
  // authenticated Cloudflare `worldcons-ops-write` boundary instead of the local
  // Supabase RPC. The boundary owns the Supabase/D1 choice, so this process
  // never needs a Supabase credential to use D1. The default `supabase`
  // authority returns false here and preserves the existing RPC path exactly.
  const delivered = await writeOpsHeartbeatViaBoundary({
    workflowKey,
    status,
    runId: workflowRunId,
    detail: canaryDetail,
    observedAt,
  });
  if (delivered) return;

  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) throw new Error("Supabase service role is not configured for workflow heartbeat.");
  const { data, error } = await supabase.rpc("ops_workflow_heartbeat_v1", {
    p_workflow_key: workflowKey,
    p_status: status,
    p_run_id: workflowRunId,
    p_detail: detail,
    p_observed_at: observedAt,
  });
  if (error) throw new Error(error.message);
  if (data !== true) throw new Error("Workflow heartbeat write was not confirmed.");
}

export async function tryRecordWorkflowHeartbeat(
  workflowKey: WorkflowKey,
  status: WorkflowHeartbeatStatus,
  detail: Record<string, unknown> = {},
) {
  try {
    await recordWorkflowHeartbeat(workflowKey, status, detail);
    return true;
  } catch (error) {
    console.warn(JSON.stringify({
      event: "worldcons_workflow_heartbeat_write_failed",
      workflowKey,
      status,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    }));
    return false;
  }
}

export async function runWithWorkflowHeartbeats(keys: readonly WorkflowKey[], operation: () => Promise<void>) {
  await Promise.all(keys.map((key) => tryRecordWorkflowHeartbeat(key, "running")));
  let status: WorkflowHeartbeatStatus = "success";
  try {
    await operation();
    if (typeof process.exitCode === "number" && process.exitCode !== 0) status = "failed";
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    await Promise.all(keys.map((key) => tryRecordWorkflowHeartbeat(key, status)));
  }
}

export async function runWithRequiredWorkflowHeartbeat<T>(
  key: WorkflowKey,
  operation: () => Promise<T>,
  recorder: typeof recordWorkflowHeartbeat = recordWorkflowHeartbeat,
) {
  await recorder(key, "running");
  try {
    const result = await operation();
    await recorder(key, "success");
    return result;
  } catch (error) {
    try {
      await recorder(key, "failed");
    } catch {
      // Preserve the operation or completion-heartbeat error as the primary failure.
    }
    throw error;
  }
}

/**
 * The resting Supabase heartbeat read, extracted so the M11.3R live read-parity
 * probe can compare the D1 read against the authoritative Supabase projection
 * regardless of the currently selected read authority. Returns `null` only when
 * the service-role client is not configured; a query error throws. The five-field
 * projection and the defensive row filter are byte-for-byte the resting read.
 */
export async function readWorkflowHeartbeatsFromSupabase(): Promise<WorkflowHeartbeatRecord[] | null> {
  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("ops_workflow_heartbeats")
    .select("workflow_key, last_started_at, last_completed_at, last_status, run_id")
    .in("workflow_key", [...WORKFLOW_KEYS]);
  if (error) throw new Error(error.message);

  return (data ?? []).flatMap((row) => {
    if (!WORKFLOW_KEYS.includes(row.workflow_key as WorkflowKey)) return [];
    if (!row.last_started_at || !["running", "success", "failed", "deferred"].includes(row.last_status)) return [];
    return [{
      workflowKey: row.workflow_key as WorkflowKey,
      lastStartedAt: row.last_started_at as string,
      lastCompletedAt: (row.last_completed_at as string | null) ?? null,
      lastStatus: row.last_status as WorkflowHeartbeatStatus,
      runId: (row.run_id as string | null) ?? null,
    }];
  });
}

export async function getWorkflowHeartbeats(): Promise<WorkflowHeartbeatRecord[] | null> {
  // M11.3R read-authority parity step. The read authority is resolved
  // independently from the write authority, so a staging write canary never
  // changes what a reader sees. The default `supabase` returns early and keeps
  // the existing local read byte-for-byte. When `d1` is selected the boundary is
  // required and fails closed: a broken or unconfigured D1 read throws (which
  // `lib/ops/watchdog.ts` and the masterdash route already surface as
  // "heartbeats unavailable"), rather than silently falling back to Supabase.
  if (shouldReadOpsHeartbeatFromD1(resolveEffectiveOpsHeartbeatReadAuthorityConfig(process.env as Record<string, string | undefined>))) {
    // Inside the Cloudflare runtime the isolated `worldcons_ops` D1 binding is
    // registered on the runtime slot and is read directly (no HTTP hop). In a
    // Node/GitHub process no binding is registered, so the same authority is
    // served through the authenticated boundary. Both paths fail closed: a
    // missing binding and a failed boundary both throw rather than returning a
    // stale or empty Supabase read.
    const binding = getRuntimeD1Binding("worldcons_ops");
    if (binding) return readOpsHeartbeatsFromD1(binding);
    const records = await readOpsHeartbeatsViaBoundary();
    if (records === null) throw new Error("ops_heartbeat_read_boundary.not_enabled");
    return records;
  }

  return readWorkflowHeartbeatsFromSupabase();
}

export const WORKFLOW_EXPECTED_INTERVAL_SECONDS: Record<WorkflowKey, number> = {
  collection: 86_400,
  summary: 21_600,
  embedding: 21_600,
  // GitHub requests a 15-minute cadence, but the durable Vercel Hobby fallback runs twice daily.
  watchdog: 43_200,
  catalog_backfill: 86_400,
};

export function workflowHeartbeatIsStale(record: WorkflowHeartbeatRecord | null | undefined, now = Date.now()) {
  if (!record) return true;
  if (record.lastStatus === "failed") return true;
  const observedAt = record.lastCompletedAt ?? record.lastStartedAt;
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return true;
  return now - observedMs > WORKFLOW_EXPECTED_INTERVAL_SECONDS[record.workflowKey] * 2.5 * 1_000;
}
