/**
 * Durable staged-ingestion repository (M0/M1).
 *
 * All reads/writes here are against `worldcons_ingest` (the source of truth for
 * stage jobs) using the runtime-safe `D1RuntimeDatabase` seam, so the same code
 * runs in the Worker, scripts and tests. Nothing imports Node builtins.
 *
 * Concurrency contract:
 * - claims are an *indexed* bounded SELECT (`stage,status,next_attempt_at,...`)
 *   followed by a *conditional* UPDATE that only transitions a row still in a
 *   claimable state. The UPDATE's `meta.changes` is the arbiter, so two
 *   dispatchers racing on one row can never both claim it.
 * - a claim stamps a `fencing_token`; every completion/advance requires the
 *   matching token, so a stale worker whose lease expired cannot complete work.
 */
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import {
  buildIngestStageIdempotencyKey,
  INGEST_STAGE_MAX_ATTEMPTS,
  type IngestStage,
  type IngestStageJobStatus,
} from "./contracts";

export interface IngestStageJobRow {
  id: string;
  idempotency_key: string;
  stage: IngestStage;
  article_id: string;
  source_key: string | null;
  source_version: string;
  content_hash: string;
  status: IngestStageJobStatus;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  claimed_by: string | null;
  claimed_attempt_id: string | null;
  claimed_fencing_token: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  last_error_summary: string | null;
  payload_ref: string | null;
  result_ref: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function ensureRows<T>(result: { success?: boolean; error?: string | null; results?: T[] }): T[] {
  if (result.success === false || result.error) throw new Error("ingest_stage.query_failed");
  return result.results ?? [];
}

function ensureWrite(result: { success?: boolean; error?: string | null; meta?: Record<string, unknown> }): number {
  if (result.success === false || result.error) throw new Error("ingest_stage.write_failed");
  const changes = result.meta?.changes;
  return typeof changes === "number" ? changes : 0;
}

function run(statement: D1RuntimePreparedStatement): Promise<{ success?: boolean; error?: string | null; meta?: Record<string, unknown> }> {
  if (!statement.run) throw new Error("ingest_stage.write_unavailable");
  return statement.run();
}

export function newIngestStageId(): string {
  return crypto.randomUUID();
}

export interface RegisterIngestStageJobInput {
  stage: IngestStage;
  articleId: string;
  sourceKey?: string | null;
  sourceVersion: string;
  contentHash: string;
  priority?: number;
  payloadRef?: string | null;
  now: string;
}

/**
 * Registers a job for `(articleId, stage, sourceVersion, contentHash)`.
 *
 * Idempotent by `unique(idempotency_key)`: a duplicate registration returns the
 * existing row unchanged, so registration is safe to replay from any discovery
 * or previous-stage producer.
 */
export async function registerIngestStageJob(
  db: D1RuntimeDatabase,
  input: RegisterIngestStageJobInput,
): Promise<{ job: IngestStageJobRow; created: boolean }> {
  const idempotencyKey = buildIngestStageIdempotencyKey({
    articleId: input.articleId,
    stage: input.stage,
    sourceVersion: input.sourceVersion,
    contentHash: input.contentHash,
  });
  const existing = await getIngestStageJobByIdempotencyKey(db, idempotencyKey);
  if (existing) return { job: existing, created: false };
  const id = newIngestStageId();
  await run(
    db
      .prepare(
        `INSERT INTO ingest_stage_jobs
          (id, idempotency_key, stage, article_id, source_key, source_version, content_hash, status, priority, attempt_count, max_attempts, next_attempt_at, payload_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .bind(
        id,
        idempotencyKey,
        input.stage,
        input.articleId,
        input.sourceKey ?? null,
        input.sourceVersion,
        input.contentHash,
        input.priority ?? 0,
        INGEST_STAGE_MAX_ATTEMPTS,
        input.now,
        input.payloadRef ?? null,
        input.now,
        input.now,
      ),
  );
  const job = await getIngestStageJobByIdempotencyKey(db, idempotencyKey);
  if (!job) throw new Error("ingest_stage.register_failed");
  return { job, created: job.id === id };
}

export async function getIngestStageJobById(db: D1RuntimeDatabase, id: string): Promise<IngestStageJobRow | null> {
  const rows = ensureRows(
    await db.prepare(`SELECT * FROM ingest_stage_jobs WHERE id = ? LIMIT 1`).bind(id).all<IngestStageJobRow>(),
  );
  return rows[0] ?? null;
}

export async function getIngestStageJobByIdempotencyKey(
  db: D1RuntimeDatabase,
  idempotencyKey: string,
): Promise<IngestStageJobRow | null> {
  const rows = ensureRows(
    await db
      .prepare(`SELECT * FROM ingest_stage_jobs WHERE idempotency_key = ? LIMIT 1`)
      .bind(idempotencyKey)
      .all<IngestStageJobRow>(),
  );
  return rows[0] ?? null;
}

export interface ClaimIngestStageJobsInput {
  stage: IngestStage;
  workerId: string;
  limit: number;
  leaseSeconds: number;
  now: string;
}

/**
 * Claims up to `limit` claimable jobs for a stage.
 *
 * The SELECT is bounded (`LIMIT`) and driven by `ingest_stage_jobs_claim_idx`,
 * matching freshly `pending` rows or `leased` rows whose lease has expired. Each
 * candidate is then conditionally transitioned; a row already taken by another
 * dispatcher yields `changes = 0` and is skipped, so the claimed set never
 * contains two dispatchers' overlapping work.
 */
export async function claimIngestStageJobs(
  db: D1RuntimeDatabase,
  input: ClaimIngestStageJobsInput,
): Promise<IngestStageJobRow[]> {
  const bounded = Math.max(1, Math.min(100, Math.trunc(input.limit)));
  const claimable = ensureRows(
    await db
      .prepare(
        `SELECT * FROM ingest_stage_jobs
          WHERE stage = ?
            AND (status = 'pending' OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY priority DESC, next_attempt_at ASC, created_at ASC
          LIMIT ?`,
      )
      .bind(input.stage, input.now, input.now, bounded)
      .all<IngestStageJobRow>(),
  );
  const leased: IngestStageJobRow[] = [];
  for (const candidate of claimable) {
    // A consumer may have crashed without recording failIngestStageJob. Its
    // expired lease is still claimable, but a job at its attempt budget must
    // not be re-leased forever (potentially repeating paid translation work).
    // Terminalize it conditionally and retain the diagnostic in D1.
    if (candidate.attempt_count >= candidate.max_attempts) {
      const changes = ensureWrite(
        await run(
          db.prepare(
            `UPDATE ingest_stage_jobs
                SET status = 'dead_letter',
                    claimed_by = NULL, claimed_attempt_id = NULL,
                    lease_expires_at = NULL, next_attempt_at = NULL,
                    last_error_code = 'ingest_stage.lease_attempts_exhausted',
                    last_error_summary = 'Lease expired after the maximum number of attempts.',
                    completed_at = ?, updated_at = ?
              WHERE id = ? AND claimed_fencing_token IS ?
                AND attempt_count >= max_attempts
                AND (status = 'pending'
                  OR (status = 'leased' AND lease_expires_at <= ?))`,
          ).bind(input.now, input.now, candidate.id, candidate.claimed_fencing_token, input.now),
        ),
      );
      if (changes === 1) {
        await appendIngestStageEvent(db, {
          jobId: candidate.id,
          stage: input.stage,
          eventType: "job_dead_lettered",
          fencingToken: candidate.claimed_fencing_token,
          safeDetails: { reason: "ingest_stage.lease_attempts_exhausted" },
          occurredAt: input.now,
        });
      }
      continue;
    }
    const attemptId = newIngestStageId();
    const fencingToken = String(candidate.attempt_count + 1);
    const leaseExpiresAt = new Date(Date.parse(input.now) + input.leaseSeconds * 1000).toISOString();
    const changes = ensureWrite(
      await run(
        db
          .prepare(
            `UPDATE ingest_stage_jobs
                SET status = 'leased',
                    claimed_by = ?,
                    claimed_attempt_id = ?,
                    claimed_fencing_token = ?,
                    lease_expires_at = ?,
                    attempt_count = attempt_count + 1,
                    updated_at = ?
              WHERE id = ?
                AND claimed_fencing_token IS ?
                AND (status = 'pending' OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))`,
          )
          .bind(
            input.workerId,
            attemptId,
            fencingToken,
            leaseExpiresAt,
            input.now,
            candidate.id,
            candidate.claimed_fencing_token,
            input.now,
          ),
      ),
    );
    if (changes !== 1) continue;
    leased.push({
      ...candidate,
      status: "leased",
      claimed_by: input.workerId,
      claimed_attempt_id: attemptId,
      claimed_fencing_token: fencingToken,
      lease_expires_at: leaseExpiresAt,
      attempt_count: candidate.attempt_count + 1,
      updated_at: input.now,
    });
    await appendIngestStageEvent(db, {
      jobId: candidate.id,
      attemptId,
      stage: input.stage,
      eventType: "job_leased",
      fencingToken,
      occurredAt: input.now,
    });
  }
  return leased;
}

export interface CompleteIngestStageJobInput {
  jobId: string;
  fencingToken: string;
  stage: IngestStage;
  resultRef?: string | null;
  now: string;
}

/**
 * Marks a leased job succeeded. Requires the matching fencing token so a worker
 * whose lease expired cannot complete the job.
 */
export async function completeIngestStageJob(
  db: D1RuntimeDatabase,
  input: CompleteIngestStageJobInput,
): Promise<boolean> {
  const changes = ensureWrite(
    await run(
      db
        .prepare(
          `UPDATE ingest_stage_jobs
              SET status = 'succeeded',
                  result_ref = ?,
                  lease_expires_at = NULL,
                  completed_at = ?,
                  updated_at = ?
            WHERE id = ?
              AND status = 'leased'
              AND claimed_fencing_token = ?`,
        )
        .bind(input.resultRef ?? null, input.now, input.now, input.jobId, input.fencingToken),
    ),
  );
  if (changes === 1) {
    await appendIngestStageEvent(db, {
      jobId: input.jobId,
      stage: input.stage,
      eventType: "job_succeeded",
      fencingToken: input.fencingToken,
      occurredAt: input.now,
    });
  }
  return changes === 1;
}

export interface FailIngestStageJobInput {
  jobId: string;
  fencingToken: string;
  stage: IngestStage;
  errorCode: string;
  errorSummary?: string | null;
  retry: boolean;
  backoffSeconds?: number;
  now: string;
}

/**
 * Fails a leased job. A retryable failure returns it to `pending` with a bounded
 * `next_attempt_at`; a terminal failure (or one that exhausted `max_attempts`)
 * moves it to `dead_letter`. Returns the resulting status, or `null` when the
 * fencing token no longer owns the job.
 */
export async function failIngestStageJob(
  db: D1RuntimeDatabase,
  input: FailIngestStageJobInput,
): Promise<{ status: IngestStageJobStatus; attemptCount: number } | null> {
  const job = await getIngestStageJobById(db, input.jobId);
  if (!job || job.claimed_fencing_token !== input.fencingToken || job.status !== "leased") return null;
  const exhausted = job.attempt_count >= job.max_attempts;
  const deadLetter = !input.retry || exhausted;
  const nextAttemptAt = deadLetter
    ? null
    : new Date(Date.parse(input.now) + (input.backoffSeconds ?? 60) * 1000).toISOString();
  const status: IngestStageJobStatus = deadLetter ? "dead_letter" : "pending";
  const changes = ensureWrite(
    await run(
      db
        .prepare(
          `UPDATE ingest_stage_jobs
              SET status = ?,
                  next_attempt_at = ?,
                  lease_expires_at = NULL,
                  claimed_by = NULL,
                  claimed_attempt_id = NULL,
                  last_error_code = ?,
                  last_error_summary = ?,
                  completed_at = ?,
                  updated_at = ?
            WHERE id = ?
              AND status = 'leased'
              AND claimed_fencing_token = ?`,
        )
        .bind(
          status,
          nextAttemptAt,
          input.errorCode,
          input.errorSummary ?? null,
          deadLetter ? input.now : null,
          input.now,
          input.jobId,
          input.fencingToken,
        ),
    ),
  );
  if (changes !== 1) return null;
  await appendIngestStageEvent(db, {
    jobId: input.jobId,
    stage: input.stage,
    eventType: deadLetter ? "job_dead_lettered" : "job_retry_scheduled",
    fencingToken: input.fencingToken,
    safeDetails: { errorCode: input.errorCode, attemptCount: job.attempt_count },
    occurredAt: input.now,
  });
  return { status, attemptCount: job.attempt_count };
}

export interface AppendIngestStageEventInput {
  jobId: string;
  stage: IngestStage;
  eventType: string;
  attemptId?: string | null;
  fencingToken?: string | null;
  safeDetails?: Record<string, unknown>;
  occurredAt: string;
}

/** Appends an append-only job event; diagnostics only, never authority. */
export async function appendIngestStageEvent(
  db: D1RuntimeDatabase,
  input: AppendIngestStageEventInput,
): Promise<void> {
  await run(
    db
      .prepare(
        `INSERT INTO ingest_stage_job_events
          (id, job_id, attempt_id, event_type, stage, fencing_token, safe_details, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newIngestStageId(),
        input.jobId,
        input.attemptId ?? null,
        input.eventType,
        input.stage,
        input.fencingToken ?? null,
        JSON.stringify(input.safeDetails ?? {}),
        input.occurredAt,
      ),
  );
}
