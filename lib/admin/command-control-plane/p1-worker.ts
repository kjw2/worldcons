import { randomUUID } from "node:crypto";
import { CandidateRetryError } from "@/lib/ingest/candidate-retry";
import { AdminP1HandlerError, createAdminP1CommandHandlers, type AdminP1CommandHandler } from "@/lib/admin/command-control-plane/p1-handlers";
import {
  adminQueueP1CommandAuthorized,
  resolveAdminQueueP1Authority,
  type AdminQueueP1Authority,
} from "@/lib/admin/command-control-plane/p1-authority";
import { adminCommandService } from "@/lib/admin/command-control-plane/service";
import type {
  AdminCommandError,
} from "@/lib/admin/command-control-plane/errors";
import type {
  AdminCommandResult,
  AdminCommandTransition,
  ClaimedAdminCommandAttempt,
  ClaimAdminCommandInput,
  FailAdminCommandAttemptInput,
} from "@/lib/admin/command-control-plane/types";
import { boundedInteger } from "@/lib/utils/numbers";

export const ADMIN_P1_WORKER_EXIT = {
  success: 0,
  configuration: 2,
  controlPlane: 3,
  commandFailed: 4,
  authorityLost: 5,
} as const;

interface AdminP1WorkerService {
  claim(input: ClaimAdminCommandInput): Promise<AdminCommandResult<ClaimedAdminCommandAttempt | null>>;
  heartbeat(attemptId: string, fencingToken: string, leaseSeconds?: number): ReturnType<typeof adminCommandService.heartbeat>;
  complete(attemptId: string, fencingToken: string, resultSummary?: Record<string, unknown>): Promise<AdminCommandResult<AdminCommandTransition>>;
  fail(input: FailAdminCommandAttemptInput): Promise<AdminCommandResult<AdminCommandTransition>>;
}

export interface AdminP1WorkerOptions {
  authority?: AdminQueueP1Authority;
  service?: AdminP1WorkerService;
  handlers?: Partial<Record<string, AdminP1CommandHandler>>;
  workerId?: string;
  maxCommands?: number;
  leaseSeconds?: number;
  heartbeatSeconds?: number;
  attemptTimeoutSeconds?: number;
  attemptTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  watchdogIntervalMs?: number;
  stopRequested?: () => boolean;
}

export interface AdminP1AttemptResult {
  commandId: string;
  runId: string;
  attemptId: string;
  status: "succeeded" | "failed" | "retry_wait" | "aborted" | "authority_lost";
  errorCode?: string;
}

export interface AdminP1WorkerResult {
  mode: "disabled" | "configuration_error" | "worker";
  exitCode: number;
  claimed: number;
  succeeded: number;
  failed: number;
  attempts: AdminP1AttemptResult[];
}

class WorkerCheckpointError extends Error {
  constructor(readonly code: string, readonly authorityLost: boolean) {
    super(code);
    this.name = "WorkerCheckpointError";
  }
}

function transitionFailure(error: AdminCommandError) {
  return new WorkerCheckpointError(error.code, ["stale_fence", "lease_lost", "aborted"].includes(error.code));
}

function safeFailure(error: unknown) {
  if (error instanceof AdminP1HandlerError) return { code: error.code, disposition: error.disposition };
  if (error instanceof CandidateRetryError) {
    return { code: error.code, disposition: error.retryable ? "retryable" as const : "terminal" as const };
  }
  if (error instanceof WorkerCheckpointError) {
    return { code: error.code, disposition: error.code === "worker_stopping" || error.code === "attempt_timeout" ? "retryable" as const : "terminal" as const };
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/timeout|timed out/.test(message)) return { code: "handler.timeout", disposition: "retryable" as const };
  if (/network|fetch failed|econn|enotfound|429|502|503|504/.test(message)) {
    return { code: "handler.network_error", disposition: "retryable" as const };
  }
  return { code: "handler.internal", disposition: "terminal" as const };
}

async function executeClaimedAttempt(
  claim: ClaimedAdminCommandAttempt,
  options: {
    authority: Extract<AdminQueueP1Authority, { enabled: true }>;
    service: AdminP1WorkerService;
    handlers: Partial<Record<string, AdminP1CommandHandler>>;
    leaseSeconds: number;
    heartbeatIntervalMs: number;
    attemptTimeoutMs: number;
    watchdogIntervalMs: number;
    stopRequested: () => boolean;
  },
): Promise<AdminP1AttemptResult> {
  const abortController = new AbortController();
  let heartbeatChain = Promise.resolve();
  let handlerActive = true;
  const deadline = Date.now() + options.attemptTimeoutMs;

  const abortExecution = (error: WorkerCheckpointError) => {
    if (!abortController.signal.aborted) abortController.abort(error);
  };

  const abortReason = () => {
    const reason = abortController.signal.reason;
    return reason instanceof WorkerCheckpointError ? reason : new WorkerCheckpointError("worker_stopping", false);
  };

  const awaitWithAbort = async <T>(operation: Promise<T>) => {
    const observed = operation.then(
      (value) => ({ type: "value" as const, value }),
      (error: unknown) => ({ type: "error" as const, error }),
    );
    if (abortController.signal.aborted) throw abortReason();
    let resolveAbort: (() => void) | undefined;
    const aborted = new Promise<{ type: "aborted" }>((resolve) => {
      resolveAbort = () => resolve({ type: "aborted" });
      abortController.signal.addEventListener("abort", resolveAbort, { once: true });
    });
    const outcome = await Promise.race([observed, aborted]);
    if (resolveAbort) abortController.signal.removeEventListener("abort", resolveAbort);
    if (outcome.type === "aborted") throw abortReason();
    if (outcome.type === "error") throw outcome.error;
    return outcome.value;
  };

  const heartbeat = async () => {
    heartbeatChain = heartbeatChain.then(async () => {
      if (!handlerActive || abortController.signal.aborted || Date.now() >= deadline) return;
      const result = await options.service.heartbeat(claim.attemptId, claim.fencingToken, options.leaseSeconds);
      if (!result.ok) abortExecution(transitionFailure(result.error));
    });
    await awaitWithAbort(heartbeatChain);
  };

  const checkpoint = async () => {
    if (abortController.signal.aborted) throw abortReason();
    if (options.stopRequested()) abortExecution(new WorkerCheckpointError("worker_stopping", false));
    if (Date.now() >= deadline) abortExecution(new WorkerCheckpointError("attempt_timeout", false));
    if (abortController.signal.aborted) throw abortReason();
    await heartbeat();
    if (abortController.signal.aborted) throw abortReason();
  };

  const heartbeatTimer = setInterval(() => {
    void heartbeat().catch(() => undefined);
  }, options.heartbeatIntervalMs);
  heartbeatTimer.unref?.();
  const watchdogTimer = setInterval(() => {
    if (!handlerActive || abortController.signal.aborted) return;
    if (options.stopRequested()) abortExecution(new WorkerCheckpointError("worker_stopping", false));
    else if (Date.now() >= deadline) abortExecution(new WorkerCheckpointError("attempt_timeout", false));
  }, options.watchdogIntervalMs);
  watchdogTimer.unref?.();
  const deadlineTimer = setTimeout(() => {
    if (handlerActive) abortExecution(new WorkerCheckpointError("attempt_timeout", false));
  }, Math.max(0, deadline - Date.now()));
  deadlineTimer.unref?.();

  try {
    const handler = options.handlers[claim.commandType];
    if (!handler) throw new AdminP1HandlerError("unsupported_command", "terminal");
    if (!adminQueueP1CommandAuthorized(options.authority, claim.commandType, claim.payloadRef)) {
      throw new AdminP1HandlerError("authority_mismatch", "terminal");
    }
    await checkpoint();
    const handlerPromise = Promise.resolve().then(() => handler(claim.payloadRef, { checkpoint, signal: abortController.signal }));
    const resultSummary = await awaitWithAbort(handlerPromise);
    await checkpoint();
    handlerActive = false;
    clearInterval(heartbeatTimer);
    clearInterval(watchdogTimer);
    clearTimeout(deadlineTimer);
    const completed = await options.service.complete(claim.attemptId, claim.fencingToken, resultSummary);
    if (!completed.ok) throw transitionFailure(completed.error);
    return { commandId: claim.commandId, runId: claim.runId, attemptId: claim.attemptId, status: "succeeded" };
  } catch (error) {
    const failure = safeFailure(error);
    if (error instanceof WorkerCheckpointError && error.authorityLost) {
      return {
        commandId: claim.commandId,
        runId: claim.runId,
        attemptId: claim.attemptId,
        status: error.code === "aborted" ? "aborted" : "authority_lost",
        errorCode: error.code,
      };
    }
    const failed = await options.service.fail({
      attemptId: claim.attemptId,
      fencingToken: claim.fencingToken,
      disposition: failure.disposition,
      errorCode: failure.code,
      errorMessage: failure.code,
      resultSummary: { status: "failed", errorCode: failure.code },
    });
    if (!failed.ok) {
      return {
        commandId: claim.commandId,
        runId: claim.runId,
        attemptId: claim.attemptId,
        status: failed.error.code === "aborted" ? "aborted" : "authority_lost",
        errorCode: failed.error.code,
      };
    }
    return {
      commandId: claim.commandId,
      runId: claim.runId,
      attemptId: claim.attemptId,
      status: failed.data.runStatus === "retry_wait" ? "retry_wait" : "failed",
      errorCode: failure.code,
    };
  } finally {
    handlerActive = false;
    clearInterval(heartbeatTimer);
    clearInterval(watchdogTimer);
    clearTimeout(deadlineTimer);
    void heartbeatChain.catch(() => undefined);
  }
}

export async function runAdminCommandWorkerP1(options: AdminP1WorkerOptions = {}): Promise<AdminP1WorkerResult> {
  const authority = options.authority ?? resolveAdminQueueP1Authority();
  if (!authority.enabled) {
    return {
      mode: authority.reason === "flag_disabled" ? "disabled" : "configuration_error",
      exitCode: authority.reason === "flag_disabled" ? ADMIN_P1_WORKER_EXIT.success : ADMIN_P1_WORKER_EXIT.configuration,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      attempts: [],
    };
  }

  const service = options.service ?? adminCommandService;
  const handlers = options.handlers ?? createAdminP1CommandHandlers();
  const workerId = options.workerId?.trim() || `github-p1:${randomUUID()}`;
  const maxCommands = boundedInteger(options.maxCommands, 5, { min: 1, max: 20 });
  const leaseSeconds = boundedInteger(options.leaseSeconds, 180, { min: 30, max: 900 });
  const heartbeatSeconds = boundedInteger(options.heartbeatSeconds, Math.max(10, Math.floor(leaseSeconds / 3)), {
    min: 5,
    max: Math.max(5, Math.floor(leaseSeconds / 2)),
  });
  const attemptTimeoutSeconds = boundedInteger(options.attemptTimeoutSeconds, 3300, { min: 30, max: 3500 });
  const attemptTimeoutMs = boundedInteger(options.attemptTimeoutMs, attemptTimeoutSeconds * 1000, { min: 25, max: 3_500_000 });
  const heartbeatIntervalMs = boundedInteger(options.heartbeatIntervalMs, heartbeatSeconds * 1000, { min: 5, max: 450_000 });
  const watchdogIntervalMs = boundedInteger(options.watchdogIntervalMs, 100, { min: 5, max: 1_000 });
  const stopRequested = options.stopRequested ?? (() => false);
  const attempts: AdminP1AttemptResult[] = [];

  for (let index = 0; index < maxCommands && !stopRequested(); index += 1) {
    const claimed = await service.claim({
      workerId,
      commandTypes: authority.commandTypes,
      cohorts: authority.cohorts,
      leaseSeconds,
    });
    if (!claimed.ok) {
      return {
        mode: "worker",
        exitCode: ADMIN_P1_WORKER_EXIT.controlPlane,
        claimed: attempts.length,
        succeeded: attempts.filter((item) => item.status === "succeeded").length,
        failed: attempts.filter((item) => item.status !== "succeeded").length,
        attempts,
      };
    }
    if (!claimed.data) break;
    attempts.push(await executeClaimedAttempt(claimed.data, {
      authority,
      service,
      handlers,
      leaseSeconds,
      heartbeatIntervalMs,
      attemptTimeoutMs,
      watchdogIntervalMs,
      stopRequested,
    }));
  }

  const succeeded = attempts.filter((item) => item.status === "succeeded").length;
  const authorityLost = attempts.some((item) => item.status === "authority_lost" || item.status === "aborted");
  const failed = attempts.length - succeeded;
  return {
    mode: "worker",
    exitCode: authorityLost
      ? ADMIN_P1_WORKER_EXIT.authorityLost
      : failed > 0
        ? ADMIN_P1_WORKER_EXIT.commandFailed
        : ADMIN_P1_WORKER_EXIT.success,
    claimed: attempts.length,
    succeeded,
    failed,
    attempts,
  };
}
