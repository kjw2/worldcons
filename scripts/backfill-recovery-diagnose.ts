import "dotenv/config";
import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import {
  evaluateBackfillRecoveryState,
  readOnlyBackfillRecoveryQueries,
  type BackfillItemClaimState,
  type BackfillRecoverySnapshot,
  type BackfillRunState,
} from "@/lib/backfill/recovery-diagnostics";

type Row = Record<string, unknown>;

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
}

function text(row: Row, key: string) {
  return typeof row[key] === "string" ? (row[key] as string) : null;
}

function numericText(row: Row, key: string) {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value.toString();
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function numberValue(row: Row, key: string) {
  const value = row[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function requiredClient() {
  const client = getSupabaseServiceRoleAdmin();
  if (!client) throw new Error("backfill_recovery.database_unavailable");
  return client;
}

async function main() {
  const snapshotId = argumentValue("snapshot");
  if (!snapshotId) throw new Error("missing_snapshot");
  const client = requiredClient();

  const snapshotResult = await client
    .from("source_inventory_snapshots")
    .select("id,source_key,scope_from,scope_to,document_type,parser_version,source_policy_version,status,discovered_count,manifest_hash")
    .eq("id", snapshotId)
    .limit(1);
  if (snapshotResult.error) throw new Error(snapshotResult.error.message || "backfill_recovery.snapshot_read_failed");
  const snapshotRow = (snapshotResult.data ?? [])[0] as Row | undefined;
  if (!snapshotRow) throw new Error("backfill_recovery.snapshot_not_found");

  const countResult = await client
    .from("source_backfill_items")
    .select("id", { count: "exact", head: true })
    .eq("snapshot_id", snapshotId);
  if (countResult.error) throw new Error(countResult.error.message || "backfill_recovery.item_count_failed");
  const observedItemCount = countResult.count ?? null;

  const itemResult = await client
    .from("source_backfill_items")
    .select("id,status,claimed_phase,claimed_attempt_id,claimed_fencing_token,lease_expires_at")
    .eq("snapshot_id", snapshotId)
    .not("claimed_attempt_id", "is", null);
  if (itemResult.error) throw new Error(itemResult.error.message || "backfill_recovery.items_read_failed");
  const itemRows = (itemResult.data ?? []) as Row[];

  const readAttempts = async (ids: string[]) => {
    if (ids.length === 0) return [] as Row[];
    const result = await client
      .from("admin_command_attempts")
      .select("id,run_id,status,lease_expires_at,fencing_token")
      .in("id", ids);
    if (result.error) throw new Error(result.error.message || "backfill_recovery.attempts_read_failed");
    return (result.data ?? []) as Row[];
  };
  const readCommandRuns = async (ids: string[]) => {
    if (ids.length === 0) return [] as Row[];
    const result = await client
      .from("admin_command_runs")
      .select("id,status,current_attempt_id")
      .in("id", ids);
    if (result.error) throw new Error(result.error.message || "backfill_recovery.command_runs_read_failed");
    return (result.data ?? []) as Row[];
  };

  const itemAttemptIds = itemRows.map((row) => text(row, "claimed_attempt_id")).filter((id): id is string => Boolean(id));
  const itemAttempts = await readAttempts(itemAttemptIds);
  const attemptById = new Map(itemAttempts.map((row) => [text(row, "id") ?? "", row]));
  const itemCommandRunIds = itemAttempts.map((row) => text(row, "run_id")).filter((id): id is string => Boolean(id));
  const itemCommandRuns = await readCommandRuns(itemCommandRunIds);
  const commandRunById = new Map(itemCommandRuns.map((row) => [text(row, "id") ?? "", row]));

  const itemClaims: BackfillItemClaimState[] = itemRows.map((row) => {
    const attempt = attemptById.get(text(row, "claimed_attempt_id") ?? "");
    const commandRun = attempt ? commandRunById.get(text(attempt, "run_id") ?? "") : undefined;
    return {
      itemId: text(row, "id") ?? "",
      status: text(row, "status") ?? "",
      claimedPhase: text(row, "claimed_phase"),
      claimedAttemptId: text(row, "claimed_attempt_id"),
      claimedFencingToken: numericText(row, "claimed_fencing_token"),
      itemLeaseExpiresAt: text(row, "lease_expires_at"),
      attemptStatus: attempt ? text(attempt, "status") : null,
      attemptRunId: attempt ? text(attempt, "run_id") : null,
      attemptFencingToken: attempt ? numericText(attempt, "fencing_token") : null,
      attemptLeaseExpiresAt: attempt ? text(attempt, "lease_expires_at") : null,
      commandRunStatus: commandRun ? text(commandRun, "status") : null,
    };
  });

  const runResult = await client
    .from("source_backfill_runs")
    .select("id,phase,pass_number,status,claimed_count,succeeded_count,terminal_failed_count,p1_attempt_id,p1_fencing_token,command_run_id,started_at")
    .eq("snapshot_id", snapshotId);
  if (runResult.error) throw new Error(runResult.error.message || "backfill_recovery.runs_read_failed");
  const runRows = (runResult.data ?? []) as Row[];

  const runAttemptIds = runRows.map((row) => text(row, "p1_attempt_id")).filter((id): id is string => Boolean(id));
  const runCommandRunIds = runRows.map((row) => text(row, "command_run_id")).filter((id): id is string => Boolean(id));
  const runAttempts = await readAttempts(runAttemptIds);
  const runAttemptById = new Map(runAttempts.map((row) => [text(row, "id") ?? "", row]));
  const runCommandRuns = await readCommandRuns(runCommandRunIds);
  const runCommandRunById = new Map(runCommandRuns.map((row) => [text(row, "id") ?? "", row]));

  const runs: BackfillRunState[] = runRows.map((row) => {
    const attempt = runAttemptById.get(text(row, "p1_attempt_id") ?? "");
    const commandRun = runCommandRunById.get(text(row, "command_run_id") ?? "");
    return {
      runId: text(row, "id") ?? "",
      phase: text(row, "phase") ?? "",
      passNumber: numberValue(row, "pass_number"),
      status: text(row, "status") ?? "",
      claimedCount: numberValue(row, "claimed_count"),
      succeededCount: numberValue(row, "succeeded_count"),
      terminalFailedCount: numberValue(row, "terminal_failed_count"),
      p1AttemptId: text(row, "p1_attempt_id"),
      p1FencingToken: numericText(row, "p1_fencing_token"),
      commandRunId: text(row, "command_run_id"),
      attemptStatus: attempt ? text(attempt, "status") : null,
      attemptRunId: attempt ? text(attempt, "run_id") : null,
      attemptFencingToken: attempt ? numericText(attempt, "fencing_token") : null,
      attemptLeaseExpiresAt: attempt ? text(attempt, "lease_expires_at") : null,
      commandRunStatus: commandRun ? text(commandRun, "status") : null,
      commandRunCurrentAttemptId: commandRun ? text(commandRun, "current_attempt_id") : null,
      startedAt: text(row, "started_at"),
    };
  });

  const snapshot: BackfillRecoverySnapshot = {
    snapshotId: text(snapshotRow, "id") ?? snapshotId,
    sourceKey: text(snapshotRow, "source_key") ?? "",
    status: text(snapshotRow, "status") ?? "",
    scopeFrom: text(snapshotRow, "scope_from"),
    scopeTo: text(snapshotRow, "scope_to"),
    documentType: text(snapshotRow, "document_type") ?? "",
    parserVersion: text(snapshotRow, "parser_version") ?? "",
    sourcePolicyVersion: text(snapshotRow, "source_policy_version") ?? "",
    discoveredCount: typeof snapshotRow.discovered_count === "number" ? snapshotRow.discovered_count : null,
    manifestHash: text(snapshotRow, "manifest_hash"),
  };

  const evaluated = evaluateBackfillRecoveryState({
    snapshot,
    itemClaims,
    runs,
    observedItemCount,
    now: new Date().toISOString(),
  });

  process.stdout.write(`${JSON.stringify({
    event: "backfill_recovery_diagnosed",
    readOnly: true,
    productionWriteAuthorizedByThisCheck: false,
    queries: readOnlyBackfillRecoveryQueries(),
    ...evaluated,
  })}\n`);
  if (evaluated.mismatches.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    event: "backfill_recovery_diagnose_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 500) : "unknown_error",
    readOnly: true,
    productionWriteAuthorizedByThisCheck: false,
  })}\n`);
  process.exitCode = 1;
});
