import { ADMIN_INGEST_JOB_TYPES, executeAdminIngestJobOptions } from "@/lib/admin/admin-ingest-jobs";
import {
  appendAdminJobEvent,
  claimAdminJob,
  markAdminJobCancelled,
  markAdminJobFailed,
  markAdminJobSucceeded,
  type AdminJobRecord,
  type AdminJobType,
} from "@/lib/db/admin-jobs";
import { classifyLlmError, classifySummaryError } from "@/lib/db/article-triage";
import { redactAdminAuditMetadata, redactAdminAuditText } from "@/lib/security/audit-redaction";

export interface RunAdminJobWorkerInput {
  workerId?: string;
  maxJobs?: number;
  leaseSeconds?: number;
  jobTypes?: Array<AdminJobType | string>;
}

interface WorkerJobResult {
  id: string;
  jobType: string;
  status: "succeeded" | "failed" | "cancelled";
  errorClass?: string | null;
  error?: string | null;
  resultSummary?: Record<string, unknown>;
}

export type AdminJobWorkerResult =
  | {
      mode: "worker";
      workerId: string;
      processed: number;
      claimed: number;
      succeeded: number;
      failed: number;
      jobs: WorkerJobResult[];
      error?: string;
    }
  | {
      mode: "unavailable";
      workerId: string;
      processed: 0;
      claimed: 0;
      succeeded: 0;
      failed: 0;
      jobs: [];
      error: string;
    };

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value ?? fallback)));
}

function errorMessage(error: unknown) {
  return redactAdminAuditText(error instanceof Error ? error.message : String(error), 500);
}

function classifyAdminJobError(error: unknown) {
  const message = errorMessage(error);
  const llmErrorClass = classifyLlmError(message);
  return llmErrorClass === "summary.model_error" ? classifySummaryError(message) : llmErrorClass;
}

function publicJob(job: AdminJobRecord) {
  return {
    id: job.id,
    jobType: job.jobType,
    sourceKey: job.sourceKey,
    articleId: job.articleId,
    articleSlug: job.articleSlug,
  };
}

async function appendEventSafe(input: Parameters<typeof appendAdminJobEvent>[0]) {
  const result = await appendAdminJobEvent(input);
  return result.ok ? null : result.error;
}

async function runClaimedJob(job: AdminJobRecord): Promise<WorkerJobResult> {
  if (job.status === "cancel_requested" || job.status === "cancelled" || job.cancelRequestedAt) {
    const cancelled = await markAdminJobCancelled({
      jobId: job.id,
      reason: job.cancelReason ?? "Cancellation was requested before worker execution.",
    });
    if (!cancelled.ok) {
      return {
        id: job.id,
        jobType: job.jobType,
        status: "failed",
        errorClass: "job.cancel_failed",
        error: cancelled.error,
        resultSummary: { status: "failed", errorClass: "job.cancel_failed" },
      };
    }
    await appendEventSafe({
      jobId: job.id,
      eventType: "cancelled",
      message: "Admin job was cancelled before worker execution.",
      metadata: publicJob(job),
    });
    return {
      id: job.id,
      jobType: job.jobType,
      status: "cancelled",
      resultSummary: { status: "cancelled" },
    };
  }

  await appendEventSafe({
    jobId: job.id,
    eventType: "started",
    message: "Admin job worker started the job.",
    metadata: publicJob(job),
  });

  try {
    const execution = await executeAdminIngestJobOptions(job.options, job.jobType);
    const resultSummary = redactAdminAuditMetadata({
      jobType: job.jobType,
      ...execution.resultSummary,
    });
    const marked = await markAdminJobSucceeded({
      jobId: job.id,
      resultSummary,
    });
    if (!marked.ok) throw new Error(`Failed to mark admin job succeeded: ${marked.error}`);

    await appendEventSafe({
      jobId: job.id,
      eventType: "succeeded",
      message: "Admin job completed successfully.",
      metadata: resultSummary,
    });

    return {
      id: job.id,
      jobType: job.jobType,
      status: "succeeded",
      resultSummary,
    };
  } catch (error) {
    const message = errorMessage(error);
    const errorClass = classifyAdminJobError(error);
    const resultSummary = redactAdminAuditMetadata({
      jobType: job.jobType,
      status: "failed",
      errorClass,
    });
    await markAdminJobFailed({
      jobId: job.id,
      errorClass,
      errorMessage: message,
      resultSummary,
    });
    await appendEventSafe({
      jobId: job.id,
      eventType: "failed",
      message,
      errorClass,
      metadata: resultSummary,
    });

    return {
      id: job.id,
      jobType: job.jobType,
      status: "failed",
      errorClass,
      error: message,
      resultSummary,
    };
  }
}

export async function runAdminJobWorker(input: RunAdminJobWorkerInput = {}): Promise<AdminJobWorkerResult> {
  const workerId = input.workerId?.trim() || `admin-worker:${Date.now()}`;
  const maxJobs = boundedInteger(input.maxJobs, 2, 1, 10);
  const leaseSeconds = boundedInteger(input.leaseSeconds, 60, 10, 600);
  const jobTypes = input.jobTypes?.length ? input.jobTypes : ADMIN_INGEST_JOB_TYPES;
  const jobs: WorkerJobResult[] = [];
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let index = 0; index < maxJobs; index += 1) {
    const claim = await claimAdminJob({ workerId, jobTypes, leaseSeconds });
    if (!claim.ok) {
      if (claim.unavailable && claimed === 0) {
        return {
          mode: "unavailable",
          workerId,
          processed: 0,
          claimed: 0,
          succeeded: 0,
          failed: 0,
          jobs: [],
          error: claim.error,
        };
      }
      return {
        mode: "worker",
        workerId,
        processed: jobs.length,
        claimed,
        succeeded,
        failed,
        jobs,
        error: claim.error,
      };
    }
    if (!claim.data) break;

    claimed += 1;
    const result = await runClaimedJob(claim.data);
    jobs.push(result);
    if (result.status === "succeeded") succeeded += 1;
    else if (result.status === "failed") failed += 1;
  }

  return {
    mode: "worker",
    workerId,
    processed: jobs.length,
    claimed,
    succeeded,
    failed,
    jobs,
  };
}
