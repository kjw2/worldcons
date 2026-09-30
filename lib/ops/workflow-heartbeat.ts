import { writeOpsHeartbeatViaBoundary, readOpsHeartbeatsViaBoundary } from "@/lib/cloudflare/ops-write/boundary-client";
import {
  OPS_HEARTBEAT_CANARY_DETAIL_KEY,
  readOpsHeartbeatsFromD1,
  runOpsHeartbeatUpsertD1,
  resolveOpsHeartbeatCanaryMarker,
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
  return (process.env.GITHUB_RUN_ID || process.env.CF_VERSION_METADATA_ID || `local-${process.pid}`).slice(0, 160);
}

export async function recordWorkflowHeartbeat(
  workflowKey: WorkflowKey,
  status: WorkflowHeartbeatStatus,
  detail: Record<string, unknown> = {},
) {
  const observedAt = new Date().toISOString();
  const workflowRunId = runId();

  const canaryDetail = resolveOpsHeartbeatCanaryMarker(process.env as Record<string, string | undefined>, workflowRunId)
    ? { ...detail, [OPS_HEARTBEAT_CANARY_DETAIL_KEY]: true }
    : detail;

  const binding = getRuntimeD1Binding("worldcons_ops");
  const parsed = {
    workflow_key: workflowKey,
    status,
    run_id: workflowRunId,
    detail: canaryDetail,
    observed_at: observedAt,
  } as const;
  if (binding) {
    await runOpsHeartbeatUpsertD1(binding, parsed);
    return;
  }
  const delivered = await writeOpsHeartbeatViaBoundary({
    workflowKey,
    status,
    runId: workflowRunId,
    detail: canaryDetail,
    observedAt,
  });
  if (!delivered) throw new Error("ops_heartbeat_d1.not_configured");
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

export async function getWorkflowHeartbeats(): Promise<WorkflowHeartbeatRecord[] | null> {
  const binding = getRuntimeD1Binding("worldcons_ops");
  if (binding) return readOpsHeartbeatsFromD1(binding);
  const records = await readOpsHeartbeatsViaBoundary();
  if (records === null) throw new Error("ops_heartbeat_read_boundary.not_enabled");
  return records;
}

export const WORKFLOW_EXPECTED_INTERVAL_SECONDS: Record<WorkflowKey, number> = {
  collection: 86_400,
  summary: 21_600,
  embedding: 21_600,
  // The Cloudflare watchdog is scheduled every 15 minutes.
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
