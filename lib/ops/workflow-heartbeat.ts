import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";

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
  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) throw new Error("Supabase service role is not configured for workflow heartbeat.");
  const { data, error } = await supabase.rpc("ops_workflow_heartbeat_v1", {
    p_workflow_key: workflowKey,
    p_status: status,
    p_run_id: runId(),
    p_detail: detail,
    p_observed_at: new Date().toISOString(),
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

export async function getWorkflowHeartbeats(): Promise<WorkflowHeartbeatRecord[] | null> {
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

export const WORKFLOW_EXPECTED_INTERVAL_SECONDS: Record<WorkflowKey, number> = {
  collection: 86_400,
  summary: 21_600,
  embedding: 21_600,
  watchdog: 900,
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
