import "dotenv/config";
import { createHash } from "node:crypto";
import {
  ADMIN_QUEUE_P1_COMMAND_TYPES,
  adminQueueP1CommandAuthorized,
  resolveAdminQueueP1Authority,
  type AdminQueueP1CommandType,
} from "@/lib/admin/command-control-plane/p1-authority";
import { adminCommandService } from "@/lib/admin/command-control-plane/service";
import { ADMIN_P1_WORKER_EXIT, runAdminCommandWorkerP1 } from "@/lib/admin/command-control-plane/p1-worker";

process.env.CRAWLEE_WORKER = "true";

let stopRequested = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopRequested = true;
  });
}

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function boundedInput(name: string, fallback: number, min: number, max: number) {
  const raw = argumentValue(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`invalid_${name}`);
  return parsed;
}

function optionalSourceKey() {
  const source = argumentValue("source")?.trim();
  if (!source) return undefined;
  const allowed = ["de-bverfg", "us-scotus", "fr-conseil-constitutionnel", "es-tribunal-constitucional"];
  if (!allowed.includes(source)) throw new Error("invalid_source");
  return source;
}

function strategy() {
  const value = argumentValue("strategy")?.trim() || "auto";
  if (!["auto", "api", "cheerio", "playwright", "sitemap", "seed"].includes(value)) {
    throw new Error("invalid_strategy");
  }
  return value as "auto" | "api" | "cheerio" | "playwright" | "sitemap" | "seed";
}

function log(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function invocationIdentity() {
  const runId = process.env.GITHUB_RUN_ID?.trim() || "local";
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT?.trim() || String(Date.now());
  return createHash("sha256").update(`${runId}:${runAttempt}`).digest("hex").slice(0, 24);
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function submitAndRun(
  commandType: AdminQueueP1CommandType,
  payloadRef: Record<string, unknown>,
  identity: string,
  retryWithinRun = false,
) {
  const authority = resolveAdminQueueP1Authority();
  if (!authority.enabled || !adminQueueP1CommandAuthorized(authority, commandType, payloadRef)) {
    return ADMIN_P1_WORKER_EXIT.configuration;
  }
  const submitted = await adminCommandService.submit({
    commandType,
    payloadRef,
    idempotencyKey: `p1:${identity}:${commandType}`,
    dedupeKey: `p1:${String(payloadRef.cohort)}:${commandType}`,
    requestedBy: "github-actions",
    maxAttempts: 3,
    retryBackoffBaseSeconds: 60,
    retryBackoffCapSeconds: 900,
  });
  if (!submitted.ok) {
    log({ event: "p1_submit_failed", errorCode: submitted.error.code });
    return ADMIN_P1_WORKER_EXIT.controlPlane;
  }
  log({
    event: "p1_submitted",
    commandId: submitted.data.commandId,
    runId: submitted.data.runId,
    status: submitted.data.runStatus,
  });
  for (let execution = 0; execution < 3; execution += 1) {
    const result = await runAdminCommandWorkerP1({
      authority,
      maxCommands: 1,
      attemptTimeoutSeconds: 2400,
      workerId: `github-p1:${process.env.GITHUB_RUN_ID || identity}`,
      stopRequested: () => stopRequested,
    });
    for (const attempt of result.attempts) log({ event: "p1_attempt", ...attempt });
    if (result.claimed === 1 && result.succeeded === 1) return ADMIN_P1_WORKER_EXIT.success;
    const retryWaiting = result.attempts[0]?.status === "retry_wait";
    if (!retryWithinRun || !retryWaiting || execution >= 2 || stopRequested) {
      return result.exitCode || ADMIN_P1_WORKER_EXIT.commandFailed;
    }
    const delaySeconds = 65 * 2 ** execution;
    log({ event: "p1_retry_wait", delaySeconds, attemptId: result.attempts[0].attemptId });
    await wait(delaySeconds * 1000);
  }
  return ADMIN_P1_WORKER_EXIT.commandFailed;
}

async function runDailyPipeline() {
  const sourceKey = optionalSourceKey();
  const limit = boundedInput("limit", 20, 1, 100);
  const rangeDays = boundedInput("range-days", 14, 1, 730);
  const summaryLimit = boundedInput("summary-limit", 20, 1, 100);
  const maxPasses = boundedInput("summary-passes", 4, 1, 8);
  const identity = invocationIdentity();
  const stages: Array<[AdminQueueP1CommandType, Record<string, unknown>]> = [
    ["p1.collect", { cohort: "daily", sourceKey, limit, rangeDays, strategy: strategy(), usePlaywright: true, refreshExisting: true }],
    ["p1.summarize", { cohort: "daily", sourceKey, limit: summaryLimit, maxPasses }],
    ["p1.refresh-derived", { cohort: "daily", scope: "all" }],
    ["p1.public-cache.revalidate", { cohort: "daily", scope: "all" }],
  ];
  for (const [commandType, payloadRef] of stages) {
    const exitCode = await submitAndRun(commandType, payloadRef, identity, true);
    if (exitCode !== ADMIN_P1_WORKER_EXIT.success) return exitCode;
  }
  return ADMIN_P1_WORKER_EXIT.success;
}

async function main() {
  const authority = resolveAdminQueueP1Authority();
  if (!authority.enabled) {
    log({ event: "p1_worker_not_started", reason: authority.reason });
    return authority.reason === "flag_disabled" ? ADMIN_P1_WORKER_EXIT.success : ADMIN_P1_WORKER_EXIT.configuration;
  }

  if (hasFlag("daily-pipeline")) return runDailyPipeline();
  const candidateId = argumentValue("candidate-id")?.trim();
  if (candidateId) {
    return submitAndRun("p1.candidate.retry", { cohort: "candidate-retry", candidateId }, invocationIdentity());
  }
  const unknownTypes = authority.commandTypes.filter((type) => !ADMIN_QUEUE_P1_COMMAND_TYPES.includes(type));
  if (unknownTypes.length > 0) return ADMIN_P1_WORKER_EXIT.configuration;
  const result = await runAdminCommandWorkerP1({
    authority,
    maxCommands: boundedInput("max-commands", 5, 1, 20),
    attemptTimeoutSeconds: 2400,
    workerId: `github-p1:${process.env.GITHUB_RUN_ID || invocationIdentity()}`,
    stopRequested: () => stopRequested,
  });
  for (const attempt of result.attempts) log({ event: "p1_attempt", ...attempt });
  log({
    event: "p1_worker_finished",
    claimed: result.claimed,
    succeeded: result.succeeded,
    failed: result.failed,
    exitCode: result.exitCode,
  });
  return result.exitCode;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch(() => {
    log({ event: "p1_worker_failed", errorCode: "invalid_input" });
    process.exitCode = ADMIN_P1_WORKER_EXIT.configuration;
  });
