import {
  OPS_HEARTBEAT_WORKFLOW_KEYS,
  parseOpsHeartbeatReadRow,
  type OpsHeartbeatReadRecord,
} from "@/lib/cloudflare/ops-write/heartbeat";
import type { D1ImportStatement } from "@/lib/cloudflare/d1/import/types";
import type { D1Database } from "@/lib/cloudflare/d1/types";

/**
 * M11.3R live read-parity comparison.
 *
 * The nodes an operator compares during the D1 read cutover:
 *
 * - the Supabase projection (the resting authoritative read);
 * - the boundary's D1 projection (`GET /v1/ops/heartbeats`);
 * - an optional independent direct-D1 read through the D1 HTTP query API.
 *
 * Timestamps are compared by INSTANT, not by byte representation: Supabase
 * (PostgREST/timestamptz) and D1 (canonical UTC ISO-8601 TEXT) may print the
 * same instant differently, and every consumer parses the value with
 * `Date.parse`. Key, status and run id are compared exactly. The comparison is
 * over exactly the five authored keys, so an absent node or an absent key is a
 * difference rather than a silently shorter list.
 */

export interface OpsHeartbeatParityDifference {
  workflowKey: string;
  field: "workflowKey" | "lastStartedAt" | "lastCompletedAt" | "lastStatus" | "runId";
  left: string | null;
  right: string | null;
}

function instantEqual(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return leftMs === rightMs;
  return left === right;
}

function difference(
  workflowKey: string,
  field: OpsHeartbeatParityDifference["field"],
  left: string | null,
  right: string | null,
): OpsHeartbeatParityDifference {
  return { workflowKey, field, left, right };
}

export function compareHeartbeatReadParity(
  left: readonly OpsHeartbeatReadRecord[],
  right: readonly OpsHeartbeatReadRecord[],
): OpsHeartbeatParityDifference[] {
  const differences: OpsHeartbeatParityDifference[] = [];
  const leftByKey = new Map(left.map((record) => [record.workflowKey, record]));
  const rightByKey = new Map(right.map((record) => [record.workflowKey, record]));
  for (const workflowKey of OPS_HEARTBEAT_WORKFLOW_KEYS) {
    const leftRecord = leftByKey.get(workflowKey);
    const rightRecord = rightByKey.get(workflowKey);
    if (!leftRecord && !rightRecord) continue;
    if (!leftRecord || !rightRecord) {
      differences.push(difference(
        workflowKey,
        "workflowKey",
        leftRecord ? workflowKey : null,
        rightRecord ? workflowKey : null,
      ));
      continue;
    }
    if (!instantEqual(leftRecord.lastStartedAt, rightRecord.lastStartedAt)) {
      differences.push(difference(workflowKey, "lastStartedAt", leftRecord.lastStartedAt, rightRecord.lastStartedAt));
    }
    if (!instantEqual(leftRecord.lastCompletedAt, rightRecord.lastCompletedAt)) {
      differences.push(difference(workflowKey, "lastCompletedAt", leftRecord.lastCompletedAt, rightRecord.lastCompletedAt));
    }
    if (leftRecord.lastStatus !== rightRecord.lastStatus) {
      differences.push(difference(workflowKey, "lastStatus", leftRecord.lastStatus, rightRecord.lastStatus));
    }
    if ((leftRecord.runId ?? null) !== (rightRecord.runId ?? null)) {
      differences.push(difference(workflowKey, "runId", leftRecord.runId, rightRecord.runId));
    }
  }
  return differences;
}

export function heartbeatReadParityHolds(
  left: readonly OpsHeartbeatReadRecord[],
  right: readonly OpsHeartbeatReadRecord[],
): boolean {
  return compareHeartbeatReadParity(left, right).length === 0;
}

/**
 * The bound-parameter D1 HTTP query surface, structurally compatible with
 * `createD1HttpQueryExecutor`. Declared here so this comparator stays free of
 * the `remote/http-query` module (and its SQL-literal helper) at import time.
 */
export type OpsHeartbeatHttpQueryExecutor = (
  database: D1Database,
  statement: D1ImportStatement,
) => Promise<Record<string, unknown>[]>;

/**
 * Independent direct-D1 read of the same five-field projection the boundary
 * serves, for the read-parity proof. One parameterized `IN (?, ...)` statement
 * over the authored keys; no caller value enters SQL text and `detail`/`updated_at`
 * are never selected.
 */
export async function readOpsHeartbeatsViaHttp(
  execute: OpsHeartbeatHttpQueryExecutor,
): Promise<OpsHeartbeatReadRecord[]> {
  const placeholders = OPS_HEARTBEAT_WORKFLOW_KEYS.map(() => "?").join(", ");
  const rows = await execute("worldcons_ops", {
    sql: "SELECT workflow_key, last_started_at, last_completed_at, last_status, run_id "
      + `FROM ops_workflow_heartbeats WHERE workflow_key IN (${placeholders})`,
    params: [...OPS_HEARTBEAT_WORKFLOW_KEYS],
  });
  if (!Array.isArray(rows)) throw new Error("ops_heartbeat_read_parity.invalid_d1_rows");
  return rows.flatMap((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("ops_heartbeat_read_parity.invalid_d1_rows");
    }
    const parsed = parseOpsHeartbeatReadRow(row as Record<string, unknown>);
    return parsed ? [parsed] : [];
  });
}
