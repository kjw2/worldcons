/**
 * Operator-safe staged-ingestion dead-letter diagnosis and redrive (next step).
 *
 * A dead-lettered stage job is terminal: `claimIngestStageJobs` and
 * `completeStageAndRecover` never touch it, so it can only move again through an
 * explicit, audited operator action. This module is that action, and it is
 * deliberately conservative:
 *
 * - **Stage-specific and bounded.** Every read (`diagnoseIngestStageJobs`,
 *   `listIngestStageDeadLetterJobs`) and the redrive target are scoped to exactly
 *   one `stage` and use an indexed, `LIMIT`-bounded query. A redrive can never
 *   move a job to another stage: a stage change is not even expressible.
 * - **Fenced.** The redrive is a *conditional* UPDATE that only fires while the
 *   row is still `dead_letter` AND the caller proves it observed the exact
 *   `claimed_fencing_token`. A concurrent re-claim (or a redrive already applied)
 *   yields `changes = 0`, so the action is denied rather than silently
 *   double-queued (optimistic concurrency).
 * - **Gate-preserving.** The redrive only returns a job to `pending`; it never
 *   marks anything succeeded, published or projected. The stage consumer re-runs
 *   the handler, which re-evaluates every public-judgment / publication gate
 *   fail-closed. No blocked/publication gate is bypassed or weakened.
 * - **Rate-limited and reasoned.** A redrive requires a non-empty operator id and
 *   reason and is capped per operator per rolling window, so a runaway caller
 *   cannot mass-requeue the DLQ.
 * - **Audited.** Every attempt, accepted or denied, is written to the append-only
 *   `ingest_stage_redrive_records` transition ledger with only non-sensitive
 *   metadata (status, attempt count, fence, error code).
 *
 * It performs no remote/DB write unless the caller invokes the redrive function,
 * and it makes no decision that does not ultimately rest on the conditional
 * UPDATE's `meta.changes`.
 */
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import {
  INGEST_STAGE_JOB_STATUSES,
  type IngestStage,
  type IngestStageJobStatus,
} from "./contracts";
import type { IngestStageJobRow } from "./repository";

/** Default redrive cap: 10 accepted redrives per operator per rolling hour. */
export const INGEST_STAGE_REDRIVE_MAX_PER_WINDOW = 10;
export const INGEST_STAGE_REDRIVE_WINDOW_SECONDS = 3600;
/** Hard bound on any listing/diagnosis scan. */
export const INGEST_STAGE_DIAGNOSIS_MAX_JOBS = 50;

export type IngestStageRedriveOutcome =
  | "redriven"
  | "denied_not_found"
  | "denied_stage_mismatch"
  | "denied_nonterminal"
  | "denied_fencing_mismatch"
  | "denied_missing_reason"
  | "denied_rate_limited";

export const INGEST_STAGE_REDRIVE_OUTCOMES: readonly IngestStageRedriveOutcome[] = [
  "redriven",
  "denied_not_found",
  "denied_stage_mismatch",
  "denied_nonterminal",
  "denied_fencing_mismatch",
  "denied_missing_reason",
  "denied_rate_limited",
] as const;

function ensureRows<T>(result: { success?: boolean; error?: string | null; results?: T[] }): T[] {
  if (result.success === false || result.error) throw new Error("ingest_stage.query_failed");
  return result.results ?? [];
}

function ensureWrite(result: { success?: boolean; error?: string | null; meta?: Record<string, unknown> }): number {
  if (result.success === false || result.error) throw new Error("ingest_stage.write_failed");
  const changes = result.meta?.changes;
  return typeof changes === "number" ? changes : 0;
}

function run(statement: D1RuntimePreparedStatement) {
  if (!statement.run) throw new Error("ingest_stage.write_unavailable");
  return statement.run();
}

function zeroCounts(): Record<IngestStageJobStatus, number> {
  return Object.fromEntries(INGEST_STAGE_JOB_STATUSES.map((status) => [status, 0])) as Record<IngestStageJobStatus, number>;
}

function bounded(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export interface IngestStageJobDiagnosis {
  stage: IngestStage;
  /** Counts of every durable status for exactly this stage. */
  counts: Record<IngestStageJobStatus, number>;
  /**
   * The oldest *claimable* pending job for the stage, or `null`. This is the
   * queue-depth age signal an operator watches for a stalled pipeline (a job that
   * has sat `pending` since `created_at` far longer than a normal dispatch tick).
   */
  oldestPendingCreatedAt: string | null;
  oldestPendingJobId: string | null;
  /** The oldest *active* (unexpired-past) lease for the stage, or `null`. */
  oldestLeaseExpiresAt: string | null;
  oldestLeaseJobId: string | null;
  /** Convenience: `counts.dead_letter`. */
  deadLetterCount: number;
}

/**
 * One bounded, per-stage observation: status counts, the oldest pending job and
 * the oldest current lease. Three indexed, single-stage-scoped `LIMIT 1`/aggregate
 * queries, so a diagnosis can never scan another stage or the whole table
 * unbounded. `pending` rows keep `claimed_fencing_token` NULL (the dispatcher
 * clears it when it releases a job for retry), so the oldest pending age reflects
 * work waiting to be dispatched, independent of a failed/in-flight lease.
 */
export async function diagnoseIngestStageJobs(
  db: D1RuntimeDatabase,
  input: { stage: IngestStage },
): Promise<IngestStageJobDiagnosis> {
  const countRows = ensureRows(
    await db
      .prepare(`SELECT status, COUNT(*) AS count FROM ingest_stage_jobs WHERE stage = ? GROUP BY status`)
      .bind(input.stage)
      .all<{ status: IngestStageJobStatus; count: number }>(),
  );
  const counts = zeroCounts();
  for (const row of countRows) {
    if (row.status in counts) counts[row.status] = Number(row.count) || 0;
  }
  const oldestPending = ensureRows(
    await db
      .prepare(
        `SELECT id, created_at FROM ingest_stage_jobs
          WHERE stage = ? AND status = 'pending'
          ORDER BY created_at ASC LIMIT 1`,
      )
      .bind(input.stage)
      .all<{ id: string; created_at: string }>(),
  )[0];
  const oldest = ensureRows(
    await db
      .prepare(
        `SELECT id, lease_expires_at FROM ingest_stage_jobs
          WHERE stage = ? AND status = 'leased' AND lease_expires_at IS NOT NULL
          ORDER BY lease_expires_at ASC LIMIT 1`,
      )
      .bind(input.stage)
      .all<{ id: string; lease_expires_at: string | null }>(),
  )[0];
  return {
    stage: input.stage,
    counts,
    oldestPendingCreatedAt: oldestPending?.created_at ?? null,
    oldestPendingJobId: oldestPending?.id ?? null,
    oldestLeaseExpiresAt: oldest?.lease_expires_at ?? null,
    oldestLeaseJobId: oldest?.id ?? null,
    deadLetterCount: counts.dead_letter,
  };
}

export interface IngestStageDeadLetterJob {
  id: string;
  articleId: string;
  stage: IngestStage;
  attemptCount: number;
  fencingToken: string | null;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Lists the dead-letter jobs for exactly one stage, newest first, bounded by
 * `LIMIT`. The returned `fencingToken` is the optimistic-concurrency token a
 * caller must echo back to `redriveIngestStageDeadLetter`.
 */
export async function listIngestStageDeadLetterJobs(
  db: D1RuntimeDatabase,
  input: { stage: IngestStage; limit?: number },
): Promise<IngestStageDeadLetterJob[]> {
  const boundedLimit = bounded(input.limit ?? INGEST_STAGE_DIAGNOSIS_MAX_JOBS, 1, INGEST_STAGE_DIAGNOSIS_MAX_JOBS, INGEST_STAGE_DIAGNOSIS_MAX_JOBS);
  const rows = ensureRows(
    await db
      .prepare(
        `SELECT id, article_id, stage, attempt_count, claimed_fencing_token,
                last_error_code, last_error_summary, created_at, updated_at
           FROM ingest_stage_jobs
          WHERE stage = ? AND status = 'dead_letter'
          ORDER BY updated_at DESC, id ASC
          LIMIT ?`,
      )
      .bind(input.stage, boundedLimit)
      .all<{
        id: string;
        article_id: string;
        stage: IngestStage;
        attempt_count: number;
        claimed_fencing_token: string | null;
        last_error_code: string | null;
        last_error_summary: string | null;
        created_at: string;
        updated_at: string;
      }>(),
  );
  return rows.map((row) => ({
    id: String(row.id),
    articleId: String(row.article_id),
    stage: row.stage,
    attemptCount: Number(row.attempt_count) || 0,
    fencingToken: row.claimed_fencing_token ?? null,
    lastErrorCode: row.last_error_code ?? null,
    lastErrorSummary: row.last_error_summary ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export interface RedriveIngestStageDeadLetterInput {
  stage: IngestStage;
  jobId: string;
  operatorId: string;
  reason: string;
  /** The `claimed_fencing_token` the operator observed when listing the job. */
  expectedFencingToken: string | null;
  maxPerWindow?: number;
  windowSeconds?: number;
  now: string;
}

export interface RedriveIngestStageDeadLetterResult {
  outcome: IngestStageRedriveOutcome;
  recordId: string;
  jobId: string;
  stage: IngestStage;
  /** The resulting job status when `outcome === "redriven"` (`pending`). */
  status: IngestStageJobStatus | null;
  /** A bounded, non-sensitive explanation suitable for an operator UI. */
  detail: string;
}

async function recentRedriveCount(
  db: D1RuntimeDatabase,
  input: { operatorId: string; windowStart: string },
): Promise<number> {
  const rows = ensureRows(
    await db
      .prepare(
        `SELECT COUNT(*) AS count FROM ingest_stage_redrive_records
          WHERE operator_id = ? AND outcome = 'redriven' AND created_at >= ?`,
      )
      .bind(input.operatorId, input.windowStart)
      .all<{ count: number }>(),
  );
  return Number(rows[0]?.count) || 0;
}

interface RedriveLedgerInput {
  jobId: string;
  stage: IngestStage;
  idempotencyKey: string | null;
  operatorId: string;
  reason: string | null;
  outcome: IngestStageRedriveOutcome;
  previousStatus: string | null;
  previousAttemptCount: number | null;
  previousFencingToken: string | null;
  previousErrorCode: string | null;
  now: string;
}

async function recordRedriveAttempt(db: D1RuntimeDatabase, input: RedriveLedgerInput): Promise<string> {
  const id = crypto.randomUUID();
  ensureWrite(
    await run(
      db
        .prepare(
          `INSERT INTO ingest_stage_redrive_records
            (id, job_id, stage, idempotency_key, operator_id, reason, outcome,
             previous_status, previous_attempt_count, previous_fencing_token,
             previous_error_code, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          input.jobId,
          input.stage,
          input.idempotencyKey,
          input.operatorId,
          input.reason,
          input.outcome,
          input.previousStatus,
          input.previousAttemptCount,
          input.previousFencingToken,
          input.previousErrorCode,
          input.now,
        ),
    ),
  );
  return id;
}

function denial(
  outcome: IngestStageRedriveOutcome,
  recordId: string,
  input: { jobId: string; stage: IngestStage },
  detail: string,
): RedriveIngestStageDeadLetterResult {
  return { outcome, recordId, jobId: input.jobId, stage: input.stage, status: null, detail };
}

/**
 * Redrives exactly one dead-letter stage job back to `pending`, fenced and
 * audited. See the module header for the full contract. Returns a discriminated
 * outcome; it never throws for an expected denial (only for a D1 write failure,
 * which fails closed).
 */
export async function redriveIngestStageDeadLetter(
  db: D1RuntimeDatabase,
  input: RedriveIngestStageDeadLetterInput,
): Promise<RedriveIngestStageDeadLetterResult> {
  const operatorId = input.operatorId.trim();
  const reason = input.reason.trim();
  const maxPerWindow = bounded(input.maxPerWindow ?? INGEST_STAGE_REDRIVE_MAX_PER_WINDOW, 0, 10_000, INGEST_STAGE_REDRIVE_MAX_PER_WINDOW);
  const windowSeconds = bounded(input.windowSeconds ?? INGEST_STAGE_REDRIVE_WINDOW_SECONDS, 60, 86_400, INGEST_STAGE_REDRIVE_WINDOW_SECONDS);

  const jobRows = ensureRows(
    await db.prepare(`SELECT * FROM ingest_stage_jobs WHERE id = ? LIMIT 1`).bind(input.jobId).all<IngestStageJobRow>(),
  );
  const job = jobRows[0];
  const baseLedger = {
    jobId: input.jobId,
    stage: input.stage,
    idempotencyKey: job?.idempotency_key ?? null,
    operatorId:
      operatorId || "unknown-operator",
    reason: reason || null,
    previousStatus: job?.status ?? null,
    previousAttemptCount: job?.attempt_count ?? null,
    previousFencingToken: job?.claimed_fencing_token ?? null,
    previousErrorCode: job?.last_error_code ?? null,
    now: input.now,
  };

  // 1. The job must exist.
  if (!job) {
    const recordId = await recordRedriveAttempt(db, { ...baseLedger, outcome: "denied_not_found" });
    return denial("denied_not_found", recordId, input, "No stage job exists for that id.");
  }
  // 2. The redrive must address the job's own stage (never a cross-stage move).
  if (job.stage !== input.stage) {
    const recordId = await recordRedriveAttempt(db, { ...baseLedger, outcome: "denied_stage_mismatch" });
    return denial("denied_stage_mismatch", recordId, input, `Job belongs to stage "${job.stage}", not "${input.stage}".`);
  }
  // 3. Only a terminal dead-letter job may be redriven. This also makes a
  //    double-redrive a denial: the first redrive left the row `pending`.
  if (job.status !== "dead_letter") {
    const recordId = await recordRedriveAttempt(db, { ...baseLedger, outcome: "denied_nonterminal" });
    return denial("denied_nonterminal", recordId, input, `Job status is "${job.status}"; only dead_letter jobs may be redriven.`);
  }
  // 4. Operator id and reason are mandatory.
  if (!operatorId || !reason) {
    const recordId = await recordRedriveAttempt(db, { ...baseLedger, outcome: "denied_missing_reason" });
    return denial("denied_missing_reason", recordId, input, "An operator id and a non-empty reason are required.");
  }
  // 5. Fencing: the caller must have observed the current token.
  if ((job.claimed_fencing_token ?? null) !== input.expectedFencingToken) {
    const recordId = await recordRedriveAttempt(db, { ...baseLedger, outcome: "denied_fencing_mismatch" });
    return denial("denied_fencing_mismatch", recordId, input, "The job's fencing token changed; refresh the diagnosis and retry.");
  }
  // 6. Rate limit per operator per rolling window.
  const windowStart = new Date(Date.parse(input.now) - windowSeconds * 1000).toISOString();
  const used = await recentRedriveCount(db, { operatorId, windowStart });
  if (used >= maxPerWindow) {
    const recordId = await recordRedriveAttempt(db, { ...baseLedger, outcome: "denied_rate_limited" });
    return denial("denied_rate_limited", recordId, input, `Operator redrive budget exhausted (${used}/${maxPerWindow} in ${windowSeconds}s).`);
  }

  // 7. Conditional, fenced transition. Everything above is advisory; this
  //    `meta.changes` is the sole arbiter. A racing claim or a second redrive
  //    makes it 0 and we deny without side effects.
  const changes = ensureWrite(
    await run(
      db
        .prepare(
          `UPDATE ingest_stage_jobs
              SET status = 'pending',
                  attempt_count = 0,
                  next_attempt_at = NULL,
                  lease_expires_at = NULL,
                  claimed_by = NULL,
                  claimed_attempt_id = NULL,
                  claimed_fencing_token = NULL,
                  last_error_code = NULL,
                  last_error_summary = NULL,
                  completed_at = NULL,
                  updated_at = ?
            WHERE id = ? AND stage = ? AND status = 'dead_letter' AND claimed_fencing_token IS ?`,
        )
        .bind(input.now, input.jobId, input.stage, input.expectedFencingToken),
    ),
  );
  if (changes !== 1) {
    // Lost the race: re-read to classify honestly (superseded vs. already redriven).
    const after = ensureRows(
      await db.prepare(`SELECT status, claimed_fencing_token FROM ingest_stage_jobs WHERE id = ? LIMIT 1`).bind(input.jobId).all<{
        status: IngestStageJobStatus;
        claimed_fencing_token: string | null;
      }>(),
    )[0];
    const outcome: IngestStageRedriveOutcome =
      after && after.status !== "dead_letter" ? "denied_nonterminal" : "denied_fencing_mismatch";
    const recordId = await recordRedriveAttempt(db, {
      ...baseLedger,
      outcome,
      previousStatus: after?.status ?? baseLedger.previousStatus,
      previousFencingToken: after?.claimed_fencing_token ?? baseLedger.previousFencingToken,
    });
    return denial(outcome, recordId, input, "The redrive lost the fencing race; the job was already claimed or redriven.");
  }

  const recordId = await recordRedriveAttempt(db, { ...baseLedger, outcome: "redriven" });
  return {
    outcome: "redriven",
    recordId,
    jobId: input.jobId,
    stage: input.stage,
    status: "pending",
    detail: "Job returned to pending under the current rollout gates.",
  };
}

export interface IngestStageRedriveRecordRow {
  id: string;
  job_id: string;
  stage: IngestStage;
  operator_id: string;
  reason: string | null;
  outcome: IngestStageRedriveOutcome;
  previous_status: string | null;
  previous_fencing_token: string | null;
  created_at: string;
}

/** Reads the append-only operator redrive transition ledger, bounded and newest first. */
export async function listIngestStageRedriveRecords(
  db: D1RuntimeDatabase,
  input: { stage?: IngestStage; jobId?: string; limit?: number },
): Promise<IngestStageRedriveRecordRow[]> {
  const boundedLimit = bounded(input.limit ?? INGEST_STAGE_DIAGNOSIS_MAX_JOBS, 1, INGEST_STAGE_DIAGNOSIS_MAX_JOBS, INGEST_STAGE_DIAGNOSIS_MAX_JOBS);
  if (input.jobId) {
    return ensureRows(
      await db
        .prepare(
          `SELECT * FROM ingest_stage_redrive_records WHERE job_id = ? ORDER BY created_at DESC, id ASC LIMIT ?`,
        )
        .bind(input.jobId, boundedLimit)
        .all<IngestStageRedriveRecordRow>(),
    );
  }
  if (input.stage) {
    return ensureRows(
      await db
        .prepare(
          `SELECT * FROM ingest_stage_redrive_records WHERE stage = ? ORDER BY created_at DESC, id ASC LIMIT ?`,
        )
        .bind(input.stage, boundedLimit)
        .all<IngestStageRedriveRecordRow>(),
    );
  }
  return ensureRows(
    await db
      .prepare(`SELECT * FROM ingest_stage_redrive_records ORDER BY created_at DESC, id ASC LIMIT ?`)
      .bind(boundedLimit)
      .all<IngestStageRedriveRecordRow>(),
  );
}
