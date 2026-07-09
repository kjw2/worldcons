import { getSupabaseAdmin } from "@/lib/db/client";
import { redactAdminAuditMetadata, redactAdminAuditText } from "@/lib/security/audit-redaction";
import { createHash } from "@/lib/utils/hash";

export const ADMIN_JOB_TYPES = [
  "ingest",
  "ingest-and-summarize",
  "summarize",
  "retry-summary",
  "refresh-tags",
  "article-bulk-action",
  "candidate-action",
  "manual-summary-edit",
  "glossary-candidates",
  "llm-test",
] as const;

export type AdminJobType = (typeof ADMIN_JOB_TYPES)[number];

export const ADMIN_JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancel_requested", "cancelled"] as const;
export type AdminJobStatus = (typeof ADMIN_JOB_STATUSES)[number];

export interface AdminJobRecord {
  id: string;
  jobType: string;
  status: AdminJobStatus | string;
  priority: number;
  sourceKey?: string | null;
  articleId?: string | null;
  articleSlug?: string | null;
  idempotencyKey: string;
  requestedBy?: string | null;
  requestedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  leaseUntil?: string | null;
  workerId?: string | null;
  progressCurrent: number;
  progressTotal?: number | null;
  resultSummary: Record<string, unknown>;
  errorClass?: string | null;
  errorMessage?: string | null;
  cancelRequestedAt?: string | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  parentJobId?: string | null;
  options: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AdminJobEventRecord {
  id: string;
  jobId: string;
  occurredAt: string;
  eventType: string;
  message?: string | null;
  errorClass?: string | null;
  metadata: Record<string, unknown>;
}

export type AdminJobResult<T> =
  | { ok: true; data: T }
  | { ok: false; unavailable?: boolean; error: string };

export interface AdminJobIdempotencyInput {
  jobType: AdminJobType | string;
  sourceKey?: string | null;
  articleId?: string | null;
  articleSlug?: string | null;
  parentJobId?: string | null;
  options?: Record<string, unknown>;
}

export interface CreateAdminJobInput extends AdminJobIdempotencyInput {
  priority?: number;
  idempotencyKey?: string;
  requestedBy?: string | null;
}

export interface ClaimAdminJobInput {
  workerId: string;
  jobTypes: Array<AdminJobType | string>;
  leaseSeconds?: number;
}

export interface AppendAdminJobEventInput {
  jobId: string;
  eventType: string;
  message?: string | null;
  errorClass?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MarkAdminJobSucceededInput {
  jobId: string;
  resultSummary?: Record<string, unknown>;
  progressCurrent?: number;
  progressTotal?: number | null;
}

export interface MarkAdminJobFailedInput {
  jobId: string;
  errorClass?: string | null;
  errorMessage?: string | null;
  resultSummary?: Record<string, unknown>;
}

export interface RequestAdminJobCancelInput {
  jobId: string;
  reason?: string | null;
}

export interface ListAdminJobsInput {
  status?: AdminJobStatus | string | null;
  jobType?: AdminJobType | string | null;
  sourceKey?: string | null;
  limit?: number;
  offset?: number;
}

export interface ListAdminJobsData {
  jobs: AdminJobRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListAdminJobEventsInput {
  jobId: string;
  limit?: number;
}

export type AdminJobSummary = Record<AdminJobStatus, number> & {
  total: number;
};

type Row = Record<string, unknown>;

const ADMIN_JOB_SELECT = [
  "id",
  "job_type",
  "status",
  "priority",
  "source_key",
  "article_id",
  "article_slug",
  "idempotency_key",
  "requested_by",
  "requested_at",
  "started_at",
  "finished_at",
  "lease_until",
  "worker_id",
  "progress_current",
  "progress_total",
  "result_summary",
  "error_class",
  "error_message",
  "cancel_requested_at",
  "cancelled_at",
  "cancel_reason",
  "parent_job_id",
  "options",
  "created_at",
  "updated_at",
].join(",");

const ADMIN_JOB_EVENT_SELECT = ["id", "job_id", "occurred_at", "event_type", "message", "error_class", "metadata"].join(",");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function nullableTextValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedListLimit(value: unknown, fallback = 50) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(1, Math.trunc(parsed)));
}

function boundedOffset(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function recordValue(value: unknown) {
  return isRecord(value) ? value : {};
}

function errorMessage(error: unknown) {
  if (!error) return "Unknown admin job error";
  if (error instanceof Error) return error.message;
  if (isRecord(error)) {
    const message = textValue(error.message);
    const details = textValue(error.details);
    return [message, details].filter(Boolean).join(" ") || JSON.stringify(error);
  }
  return String(error);
}

function errorCode(error: unknown) {
  return isRecord(error) ? textValue(error.code) : "";
}

function isAdminJobsUnavailable(error: unknown) {
  const code = errorCode(error);
  const message = errorMessage(error).toLowerCase();
  return (
    code === "42P01" ||
    code === "42883" ||
    code === "42703" ||
    code === "PGRST202" ||
    code === "PGRST204" ||
    message.includes("admin_jobs") ||
    message.includes("admin_job_events") ||
    message.includes("claim_admin_job") ||
    message.includes("append_admin_job_event") ||
    message.includes("schema cache")
  );
}

function failure<T>(error: unknown): AdminJobResult<T> {
  return {
    ok: false,
    unavailable: isAdminJobsUnavailable(error) || undefined,
    error: errorMessage(error),
  };
}

function unavailable<T>(message: string): AdminJobResult<T> {
  return { ok: false, unavailable: true, error: message };
}

function redactedRecord(value?: Record<string, unknown>) {
  return redactAdminAuditMetadata(value);
}

function redactedText(value?: string | null, max = 500) {
  return value ? redactAdminAuditText(value, max) : null;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])] as const)
      .filter(([, entryValue]) => entryValue !== undefined),
  );
}

function firstRow(value: unknown): Row | null {
  if (Array.isArray(value)) return isRecord(value[0]) ? value[0] : null;
  return isRecord(value) ? value : null;
}

function rowToAdminJob(row: Row): AdminJobRecord {
  return {
    id: textValue(row.id),
    jobType: textValue(row.job_type),
    status: textValue(row.status) as AdminJobStatus | string,
    priority: numberValue(row.priority),
    sourceKey: nullableTextValue(row.source_key),
    articleId: nullableTextValue(row.article_id),
    articleSlug: nullableTextValue(row.article_slug),
    idempotencyKey: textValue(row.idempotency_key),
    requestedBy: nullableTextValue(row.requested_by),
    requestedAt: textValue(row.requested_at),
    startedAt: nullableTextValue(row.started_at),
    finishedAt: nullableTextValue(row.finished_at),
    leaseUntil: nullableTextValue(row.lease_until),
    workerId: nullableTextValue(row.worker_id),
    progressCurrent: numberValue(row.progress_current),
    progressTotal: nullableNumberValue(row.progress_total),
    resultSummary: redactedRecord(recordValue(row.result_summary)),
    errorClass: redactedText(nullableTextValue(row.error_class), 160),
    errorMessage: redactedText(nullableTextValue(row.error_message), 500),
    cancelRequestedAt: nullableTextValue(row.cancel_requested_at),
    cancelledAt: nullableTextValue(row.cancelled_at),
    cancelReason: nullableTextValue(row.cancel_reason),
    parentJobId: nullableTextValue(row.parent_job_id),
    options: redactedRecord(recordValue(row.options)),
    createdAt: textValue(row.created_at),
    updatedAt: textValue(row.updated_at),
  };
}

function rowToAdminJobEvent(row: Row): AdminJobEventRecord {
  return {
    id: textValue(row.id),
    jobId: textValue(row.job_id),
    occurredAt: textValue(row.occurred_at),
    eventType: textValue(row.event_type),
    message: redactedText(nullableTextValue(row.message), 500),
    errorClass: redactedText(nullableTextValue(row.error_class), 160),
    metadata: redactedRecord(recordValue(row.metadata)),
  };
}

export function buildAdminJobIdempotencyKey(input: AdminJobIdempotencyInput) {
  const payload = stableJsonValue({
    jobType: input.jobType,
    sourceKey: input.sourceKey ?? null,
    articleId: input.articleId ?? null,
    articleSlug: input.articleSlug ?? null,
    parentJobId: input.parentJobId ?? null,
    options: redactedRecord(input.options),
  });
  return `admin-job:${input.jobType}:${createHash(JSON.stringify(payload), 64)}`;
}

export async function createAdminJob(input: CreateAdminJobInput): Promise<AdminJobResult<{ job: AdminJobRecord; created: boolean }>> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return unavailable("Supabase is not configured for admin jobs.");

  const idempotencyKey = input.idempotencyKey ?? buildAdminJobIdempotencyKey(input);
  const payload = {
    job_type: input.jobType,
    priority: Math.trunc(input.priority ?? 0),
    source_key: redactedText(input.sourceKey, 120),
    article_id: input.articleId ?? null,
    article_slug: redactedText(input.articleSlug, 300),
    idempotency_key: idempotencyKey,
    requested_by: redactedText(input.requestedBy, 160),
    parent_job_id: input.parentJobId ?? null,
    options: redactedRecord(input.options),
  };

  const { data, error } = await supabase.from("admin_jobs").insert(payload).select("*").single();
  if (!error && isRecord(data)) return { ok: true, data: { job: rowToAdminJob(data), created: true } };

  if (errorCode(error) === "23505") {
    const existing = await supabase.from("admin_jobs").select("*").eq("idempotency_key", idempotencyKey).maybeSingle();
    if (!existing.error && existing.data && isRecord(existing.data)) {
      return { ok: true, data: { job: rowToAdminJob(existing.data), created: false } };
    }
    return failure(existing.error ?? error);
  }

  return failure(error);
}

export async function claimAdminJob(input: ClaimAdminJobInput): Promise<AdminJobResult<AdminJobRecord | null>> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return unavailable("Supabase is not configured for admin jobs.");

  const { data, error } = await supabase.rpc("claim_admin_job", {
    worker_id: input.workerId,
    job_types: input.jobTypes,
    lease_seconds: input.leaseSeconds ?? 60,
  });
  if (error) return failure(error);

  const row = firstRow(data);
  return { ok: true, data: row ? rowToAdminJob(row) : null };
}

export async function appendAdminJobEvent(input: AppendAdminJobEventInput): Promise<AdminJobResult<AdminJobEventRecord>> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return unavailable("Supabase is not configured for admin jobs.");

  const { data, error } = await supabase.rpc("append_admin_job_event", {
    job_id: input.jobId,
    event_type: redactAdminAuditText(input.eventType, 120),
    message: redactedText(input.message, 500),
    error_class: redactedText(input.errorClass, 160),
    metadata: redactedRecord(input.metadata),
  });
  if (error) return failure(error);

  const row = firstRow(data);
  if (!row) return failure("append_admin_job_event returned no row.");
  return { ok: true, data: rowToAdminJobEvent(row) };
}

export async function markAdminJobSucceeded(input: MarkAdminJobSucceededInput): Promise<AdminJobResult<AdminJobRecord>> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return unavailable("Supabase is not configured for admin jobs.");

  const update = {
    status: "succeeded",
    finished_at: new Date().toISOString(),
    lease_until: null,
    worker_id: null,
    progress_current: Math.max(0, Math.trunc(input.progressCurrent ?? input.progressTotal ?? 0)),
    progress_total: input.progressTotal ?? null,
    result_summary: redactedRecord(input.resultSummary),
    error_class: null,
    error_message: null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("admin_jobs").update(update).eq("id", input.jobId).select("*").maybeSingle();
  if (error) return failure(error);
  if (!data || !isRecord(data)) return failure(`Admin job ${input.jobId} was not found.`);
  return { ok: true, data: rowToAdminJob(data) };
}

export async function markAdminJobFailed(input: MarkAdminJobFailedInput): Promise<AdminJobResult<AdminJobRecord>> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return unavailable("Supabase is not configured for admin jobs.");

  const update = {
    status: "failed",
    finished_at: new Date().toISOString(),
    lease_until: null,
    worker_id: null,
    result_summary: redactedRecord(input.resultSummary),
    error_class: redactedText(input.errorClass, 160),
    error_message: redactedText(input.errorMessage, 500),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("admin_jobs").update(update).eq("id", input.jobId).select("*").maybeSingle();
  if (error) return failure(error);
  if (!data || !isRecord(data)) return failure(`Admin job ${input.jobId} was not found.`);
  return { ok: true, data: rowToAdminJob(data) };
}

export async function requestAdminJobCancel(input: RequestAdminJobCancelInput): Promise<AdminJobResult<AdminJobRecord>> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return unavailable("Supabase is not configured for admin jobs.");

  const update = {
    status: "cancel_requested",
    cancel_requested_at: new Date().toISOString(),
    cancel_reason: redactedText(input.reason, 500),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("admin_jobs").update(update).eq("id", input.jobId).select("*").maybeSingle();
  if (error) return failure(error);
  if (!data || !isRecord(data)) return failure(`Admin job ${input.jobId} was not found.`);
  return { ok: true, data: rowToAdminJob(data) };
}

export async function listAdminJobs(input: ListAdminJobsInput = {}): Promise<AdminJobResult<ListAdminJobsData>> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return unavailable("Supabase is not configured for admin jobs.");

  const limit = boundedListLimit(input.limit);
  const offset = boundedOffset(input.offset);
  let query = supabase.from("admin_jobs").select(ADMIN_JOB_SELECT, { count: "exact" });
  const status = redactedText(input.status, 80);
  const jobType = redactedText(input.jobType, 120);
  const sourceKey = redactedText(input.sourceKey, 120);

  if (status) query = query.eq("status", status);
  if (jobType) query = query.eq("job_type", jobType);
  if (sourceKey) query = query.eq("source_key", sourceKey);

  const { data, error, count } = await query.order("requested_at", { ascending: false }).range(offset, offset + limit - 1);
  if (error) return failure(error);

  return {
    ok: true,
    data: {
      jobs: Array.isArray(data) ? (data as unknown[]).filter(isRecord).map(rowToAdminJob) : [],
      total: count ?? 0,
      limit,
      offset,
    },
  };
}

export async function listAdminJobEvents(input: ListAdminJobEventsInput): Promise<AdminJobResult<AdminJobEventRecord[]>> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return unavailable("Supabase is not configured for admin jobs.");

  const jobId = input.jobId.trim();
  if (!jobId) return failure("Admin job id is required.");

  const { data, error } = await supabase
    .from("admin_job_events")
    .select(ADMIN_JOB_EVENT_SELECT)
    .eq("job_id", jobId)
    .order("occurred_at", { ascending: false })
    .limit(boundedListLimit(input.limit, 10));
  if (error) return failure(error);

  return { ok: true, data: Array.isArray(data) ? (data as unknown[]).filter(isRecord).map(rowToAdminJobEvent) : [] };
}

export async function getAdminJobSummary(): Promise<AdminJobResult<AdminJobSummary>> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return unavailable("Supabase is not configured for admin jobs.");

  const entries: Array<[AdminJobStatus, number]> = [];
  for (const status of ADMIN_JOB_STATUSES) {
    const { count, error } = await supabase.from("admin_jobs").select("id", { count: "exact", head: true }).eq("status", status);
    if (error) return failure(error);
    entries.push([status, count ?? 0]);
  }

  const summary = Object.fromEntries(entries) as AdminJobSummary;
  summary.total = entries.reduce((sum, [, count]) => sum + count, 0);
  return { ok: true, data: summary };
}
