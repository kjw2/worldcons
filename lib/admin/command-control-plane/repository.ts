import { getSupabaseAdmin } from "@/lib/db/client";
import { adminCommandError, mapAdminCommandDatabaseError } from "@/lib/admin/command-control-plane/errors";
import type {
  AbortAdminCommandRunInput,
  AbortedAdminCommandRun,
  AdminCommandLease,
  AdminCommandRepository,
  AdminCommandResult,
  AdminCommandRunStatus,
  AdminCommandTransition,
  ClaimAdminCommandInput,
  ClaimedAdminCommandAttempt,
  FailAdminCommandAttemptInput,
  RetriedAdminCommandRun,
  SubmitAdminCommandInput,
  SubmittedAdminCommand,
} from "@/lib/admin/command-control-plane/types";

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRow(value: unknown) {
  if (Array.isArray(value)) return isRecord(value[0]) ? value[0] : null;
  return isRecord(value) ? value : null;
}

function text(row: Row, key: string) {
  return typeof row[key] === "string" ? row[key] as string : "";
}

function nullableText(row: Row, key: string) {
  return typeof row[key] === "string" ? row[key] as string : null;
}

function number(row: Row, key: string) {
  const value = row[key];
  return typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
}

function boolean(row: Row, key: string) {
  return row[key] === true;
}

function record(row: Row, key: string) {
  return isRecord(row[key]) ? row[key] as Record<string, unknown> : {};
}

function failure<T>(error: unknown): AdminCommandResult<T> {
  return { ok: false, error: mapAdminCommandDatabaseError(error) };
}

async function rpc<T>(name: string, args: Record<string, unknown>, map: (row: Row) => T): Promise<AdminCommandResult<T>> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false, error: adminCommandError("unavailable") };
  const { data, error } = await supabase.rpc(name, args);
  if (error) return failure(error);
  const row = firstRow(data);
  if (!row) return { ok: false, error: adminCommandError("internal") };
  return { ok: true, data: map(row) };
}

export const postgresAdminCommandRepository: AdminCommandRepository = {
  submit(input: SubmitAdminCommandInput) {
    return rpc<SubmittedAdminCommand>(
      "admin_submit_command_v3",
      {
        p_command_type: input.commandType,
        p_payload_ref: input.payloadRef,
        p_idempotency_key: input.idempotencyKey,
        p_dedupe_key: input.dedupeKey,
        p_requested_by: input.requestedBy ?? null,
        p_priority: input.priority ?? 0,
        p_max_attempts: input.maxAttempts ?? 3,
        p_retry_backoff_base_seconds: input.retryBackoffBaseSeconds ?? 15,
        p_retry_backoff_cap_seconds: input.retryBackoffCapSeconds ?? 900,
        p_shadow_only: input.shadowOnly ?? false,
      },
      (row) => ({
        commandId: text(row, "command_id"),
        runId: text(row, "run_id"),
        runStatus: text(row, "run_status") as AdminCommandRunStatus,
        created: boolean(row, "created"),
        deduplicated: boolean(row, "deduplicated"),
      }),
    );
  },

  async claim(input: ClaimAdminCommandInput) {
    const supabase = getSupabaseAdmin();
    if (!supabase) return { ok: false as const, error: adminCommandError("unavailable") };
    const { data, error } = await supabase.rpc("admin_claim_command_attempt_v3", {
      p_worker_id: input.workerId,
      p_command_types: input.commandTypes?.length ? input.commandTypes : null,
      p_lease_seconds: input.leaseSeconds ?? 60,
    });
    if (error) return failure<ClaimedAdminCommandAttempt | null>(error);
    const row = firstRow(data);
    if (!row) return { ok: true as const, data: null };
    return {
      ok: true as const,
      data: {
        commandId: text(row, "command_id"),
        runId: text(row, "run_id"),
        attemptId: text(row, "attempt_id"),
        commandType: text(row, "command_type"),
        payloadRef: record(row, "payload_ref"),
        attemptNumber: number(row, "attempt_number"),
        fencingToken: text(row, "fencing_token"),
        leaseExpiresAt: text(row, "lease_expires_at"),
        abortRequestedAt: nullableText(row, "abort_requested_at"),
      },
    };
  },

  heartbeat(attemptId: string, fencingToken: string, leaseSeconds = 60) {
    return rpc<AdminCommandLease>(
      "admin_heartbeat_command_attempt_v3",
      { p_attempt_id: attemptId, p_fencing_token: fencingToken, p_lease_seconds: leaseSeconds },
      (row) => ({
        attemptId: text(row, "attempt_id"),
        runId: text(row, "run_id"),
        fencingToken: text(row, "fencing_token"),
        heartbeatAt: text(row, "heartbeat_at"),
        leaseExpiresAt: text(row, "lease_expires_at"),
      }),
    );
  },

  complete(attemptId: string, fencingToken: string, resultSummary = {}) {
    return rpc<AdminCommandTransition>(
      "admin_complete_command_attempt_v3",
      { p_attempt_id: attemptId, p_fencing_token: fencingToken, p_result_summary: resultSummary },
      (row) => ({
        runId: text(row, "run_id"),
        runStatus: text(row, "run_status") as AdminCommandRunStatus,
        attemptId: text(row, "attempt_id"),
        attemptStatus: text(row, "attempt_status"),
      }),
    );
  },

  fail(input: FailAdminCommandAttemptInput) {
    return rpc<AdminCommandTransition>(
      "admin_fail_command_attempt_v3",
      {
        p_attempt_id: input.attemptId,
        p_fencing_token: input.fencingToken,
        p_failure_disposition: input.disposition,
        p_error_code: input.errorCode,
        p_error_message: input.errorMessage ?? null,
        p_result_summary: input.resultSummary ?? {},
      },
      (row) => ({
        runId: text(row, "run_id"),
        runStatus: text(row, "run_status") as AdminCommandRunStatus,
        attemptId: text(row, "attempt_id"),
        attemptStatus: text(row, "attempt_status"),
        retryAt: nullableText(row, "retry_at"),
      }),
    );
  },

  abort(input: AbortAdminCommandRunInput) {
    return rpc<AbortedAdminCommandRun>(
      "admin_abort_command_run_v3",
      { p_run_id: input.runId, p_requested_by: input.requestedBy, p_reason: input.reason ?? null },
      (row) => ({
        runId: text(row, "run_id"),
        runStatus: text(row, "run_status") as AdminCommandRunStatus,
        abortRequestedAt: text(row, "abort_requested_at"),
        finishedAt: text(row, "finished_at"),
      }),
    );
  },

  retry(runId: string, requestedBy: string, reason?: string | null) {
    return rpc<RetriedAdminCommandRun>(
      "admin_retry_command_run_v3",
      { p_run_id: runId, p_requested_by: requestedBy, p_reason: reason ?? null },
      (row) => ({
        commandId: text(row, "command_id"),
        runId: text(row, "run_id"),
        runNumber: number(row, "run_number"),
        runStatus: text(row, "run_status") as AdminCommandRunStatus,
      }),
    );
  },
};
