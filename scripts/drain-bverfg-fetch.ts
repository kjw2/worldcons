import "dotenv/config";
import { spawn } from "node:child_process";
import { postgresCaseBackfillRepository } from "@/lib/backfill/repository";
import { defaultCaseBackfillBatchLimit } from "@/lib/backfill/operation-policy";
import type { CaseBackfillPassInput } from "@/lib/backfill/types";

const SOURCE_KEY = "de-bverfg";
const PHASE = "fetch" as const;
const FETCH_CONTRACT_VERSION = "bverfg-official-fetch-v1";

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

function requiredUuid(name: string) {
  const value = argumentValue(name)?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`invalid_${name}`);
  }
  return value;
}

function integerArgument(name: string, fallback: number, min: number, max: number) {
  const raw = argumentValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid_${name}`);
  return value;
}

function safeActor() {
  const value = argumentValue("requested-by")?.trim() || "worldcons-unattended-operations";
  if (!/^[a-z0-9._:@-]{1,160}$/i.test(value)) throw new Error("invalid_requested-by");
  return value;
}

function output(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function runBoundedPass(input: {
  snapshotId: string;
  batchLimit: number;
  requestedBy: string;
}) {
  const pnpmScript = process.env.npm_execpath?.trim();
  const executable = pnpmScript ? process.execPath : process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const args = [
    ...(pnpmScript ? [pnpmScript] : []),
    "backfill:corpus",
    PHASE,
    "--",
    "--source=germany",
    `--snapshot=${input.snapshotId}`,
    `--batch-limit=${input.batchLimit}`,
    "--execute",
    `--requested-by=${input.requestedBy}`,
  ];
  return new Promise<number>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`bverfg_fetch_drain_child_signal_${signal.toLowerCase()}`));
      else resolve(code ?? 1);
    });
  });
}

async function main() {
  const snapshotId = requiredUuid("snapshot");
  const requestedBy = safeActor();
  const batchLimit = integerArgument(
    "batch-limit",
    defaultCaseBackfillBatchLimit(SOURCE_KEY, PHASE),
    1,
    10,
  );
  const maxPasses = integerArgument("max-passes", 25, 1, 500);
  const retryPollSeconds = integerArgument("retry-poll-seconds", 65, 5, 300);
  const maxConsecutiveFailures = integerArgument("max-consecutive-failures", 3, 1, 20);
  const maxIdlePolls = integerArgument("max-idle-polls", 60, 1, 1_440);
  const snapshot = await postgresCaseBackfillRepository.getSnapshot(snapshotId);
  if (snapshot.sourceKey !== SOURCE_KEY) throw new Error("bverfg_fetch_drain_snapshot_source_mismatch");
  if (snapshot.status !== "closed") throw new Error("bverfg_fetch_drain_snapshot_not_closed");

  const backlogInput: CaseBackfillPassInput = {
    cohort: "catalog-backfill",
    snapshotId,
    phase: PHASE,
    passNumber: 1,
    batchLimit,
    parserVersion: snapshot.parserVersion,
    normalizationContractVersion: "case-normalized-v1",
    fetchContractVersion: FETCH_CONTRACT_VERSION,
  };
  const initialDueBacklog = await postgresCaseBackfillRepository.countBacklog(backlogInput);
  const initialStatus = await postgresCaseBackfillRepository.getSnapshotStatus(snapshotId);
  output({
    event: "bverfg_fetch_drain_planned",
    snapshotId,
    batchLimit,
    maxPasses,
    retryPollSeconds,
    maxConsecutiveFailures,
    initialDueBacklog,
    initialRetryWait: initialStatus.retryWait,
    execute: flag("execute"),
    publicCatalogWrites: 0,
    geminiCalls: 0,
  });
  if (!flag("execute")) return 0;

  let completedPasses = 0;
  let consecutiveFailures = 0;
  let idlePolls = 0;
  while (completedPasses < maxPasses) {
    const dueBacklog = await postgresCaseBackfillRepository.countBacklog(backlogInput);
    const status = await postgresCaseBackfillRepository.getSnapshotStatus(snapshotId);
    if (status.failed > 0) throw new Error("bverfg_fetch_drain_terminal_failure");
    if (dueBacklog === 0) {
      if (status.retryWait === 0) {
        output({
          event: "bverfg_fetch_drain_completed",
          snapshotId,
          completedPasses,
          retryWait: 0,
          publicCatalogWrites: 0,
          geminiCalls: 0,
        });
        return 0;
      }
      idlePolls += 1;
      if (idlePolls > maxIdlePolls) throw new Error("bverfg_fetch_drain_retry_wait_limit");
      output({ event: "bverfg_fetch_drain_waiting", snapshotId, completedPasses, retryWait: status.retryWait, idlePolls });
      await wait(retryPollSeconds * 1000);
      continue;
    }

    idlePolls = 0;
    const passExitCode = await runBoundedPass({ snapshotId, batchLimit, requestedBy });
    completedPasses += 1;
    if (passExitCode === 0) consecutiveFailures = 0;
    else consecutiveFailures += 1;
    const remainingDueBacklog = await postgresCaseBackfillRepository.countBacklog(backlogInput);
    const afterStatus = await postgresCaseBackfillRepository.getSnapshotStatus(snapshotId);
    output({
      event: "bverfg_fetch_drain_progress",
      snapshotId,
      completedPasses,
      passExitCode,
      consecutiveFailures,
      remainingDueBacklog,
      retryWait: afterStatus.retryWait,
      terminalFailureCount: afterStatus.failed,
      publicCatalogWrites: 0,
      geminiCalls: 0,
    });
    if (afterStatus.failed > 0) throw new Error("bverfg_fetch_drain_terminal_failure");
    if (passExitCode !== 0) {
      if (consecutiveFailures >= maxConsecutiveFailures) {
        throw new Error("bverfg_fetch_drain_consecutive_failure_limit");
      }
      await wait(retryPollSeconds * 1000);
    }
  }

  const remainingDueBacklog = await postgresCaseBackfillRepository.countBacklog(backlogInput);
  const finalStatus = await postgresCaseBackfillRepository.getSnapshotStatus(snapshotId);
  output({
    event: "bverfg_fetch_drain_bounded_stop",
    snapshotId,
    completedPasses,
    remainingDueBacklog,
    remainingRetryWait: finalStatus.retryWait,
    terminalFailureCount: finalStatus.failed,
    publicCatalogWrites: 0,
    geminiCalls: 0,
  });
  return remainingDueBacklog === 0 && finalStatus.retryWait === 0 && finalStatus.failed === 0 ? 0 : 2;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  output({
    event: "bverfg_fetch_drain_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 160) : "unknown_error",
    publicCatalogWrites: 0,
    geminiCalls: 0,
  });
  process.exitCode = 1;
});
