import type { AdminCommandError } from "@/lib/admin/command-control-plane/errors";

export const ADMIN_COMMAND_RUN_STATUSES = [
  "queued",
  "running",
  "retry_wait",
  "succeeded",
  "failed",
  "aborted",
  "shadowed",
] as const;

export type AdminCommandRunStatus = (typeof ADMIN_COMMAND_RUN_STATUSES)[number];
export type AdminCommandFailureDisposition = "retryable" | "terminal";
export type AdminCommandResult<T> = { ok: true; data: T } | { ok: false; error: AdminCommandError };

export interface SubmitAdminCommandInput {
  commandType: string;
  payloadRef: Record<string, unknown>;
  idempotencyKey: string;
  dedupeKey: string;
  requestedBy?: string | null;
  priority?: number;
  maxAttempts?: number;
  retryBackoffBaseSeconds?: number;
  retryBackoffCapSeconds?: number;
  shadowOnly?: boolean;
}

export interface SubmittedAdminCommand {
  commandId: string;
  runId: string;
  runStatus: AdminCommandRunStatus;
  created: boolean;
  deduplicated: boolean;
}

export interface ClaimAdminCommandInput {
  workerId: string;
  commandTypes?: string[];
  cohorts?: string[];
  leaseSeconds?: number;
}

export interface ClaimedAdminCommandAttempt {
  commandId: string;
  runId: string;
  attemptId: string;
  commandType: string;
  payloadRef: Record<string, unknown>;
  attemptNumber: number;
  fencingToken: string;
  leaseExpiresAt: string;
  abortRequestedAt?: string | null;
}

export interface AdminCommandLease {
  attemptId: string;
  runId: string;
  fencingToken: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
}

export interface AdminCommandTransition {
  runId: string;
  runStatus: AdminCommandRunStatus;
  attemptId: string;
  attemptStatus: string;
  retryAt?: string | null;
}

export interface FailAdminCommandAttemptInput {
  attemptId: string;
  fencingToken: string;
  disposition: AdminCommandFailureDisposition;
  errorCode: string;
  errorMessage?: string | null;
  resultSummary?: Record<string, unknown>;
}

export interface AbortAdminCommandRunInput {
  runId: string;
  requestedBy: string;
  reason?: string | null;
}

export interface AbortedAdminCommandRun {
  runId: string;
  runStatus: AdminCommandRunStatus;
  abortRequestedAt: string;
  finishedAt: string;
}

export interface RetriedAdminCommandRun {
  commandId: string;
  runId: string;
  runNumber: number;
  runStatus: AdminCommandRunStatus;
}

export interface AdminCommandRepository {
  submit(input: SubmitAdminCommandInput): Promise<AdminCommandResult<SubmittedAdminCommand>>;
  claim(input: ClaimAdminCommandInput): Promise<AdminCommandResult<ClaimedAdminCommandAttempt | null>>;
  heartbeat(attemptId: string, fencingToken: string, leaseSeconds?: number): Promise<AdminCommandResult<AdminCommandLease>>;
  complete(
    attemptId: string,
    fencingToken: string,
    resultSummary?: Record<string, unknown>,
  ): Promise<AdminCommandResult<AdminCommandTransition>>;
  fail(input: FailAdminCommandAttemptInput): Promise<AdminCommandResult<AdminCommandTransition>>;
  abort(input: AbortAdminCommandRunInput): Promise<AdminCommandResult<AbortedAdminCommandRun>>;
  retry(runId: string, requestedBy: string, reason?: string | null): Promise<AdminCommandResult<RetriedAdminCommandRun>>;
}
