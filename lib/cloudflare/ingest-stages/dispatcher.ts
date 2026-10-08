/**
 * Staged-ingestion dispatcher (M1).
 *
 * One dispatcher worker drains the per-stage `pending`/`expired-lease` jobs for
 * a single stage via the indexed claim, then for each claimed job:
 *
 *   1. builds the ID-only Queue message,
 *   2. commits a durable dispatch outbox row (D1 -> Queue is not atomic),
 *   3. sends the Queue message,
 *   4. marks the outbox row dispatched (or releases the job for retry).
 *
 * A crash between 2 and 4 leaves a `pending` outbox row that
 * `reconcileIngestStageDispatch` replays, so an accepted job is never lost.
 *
 * The dispatcher is idempotent: re-claiming the same job rebuilds the same
 * deterministic message id and reuses the same outbox row.
 */
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import {
  buildIngestStageIdempotencyKey,
  buildIngestStageQueueMessage,
  INGEST_STAGE_MAX_ATTEMPTS,
  INGEST_STAGE_NEXT,
  INGEST_STAGE_QUEUES,
  type IngestStage,
  type IngestStageQueueMessage,
} from "./contracts";
import {
  appendIngestStageEvent,
  claimIngestStageJobs,
  failIngestStageJob,
  getIngestStageJobById,
  getIngestStageJobByIdempotencyKey,
  newIngestStageId,
  type IngestStageJobRow,
} from "./repository";
import {
  listPendingIngestStageDispatch,
  markIngestStageDispatchDispatched,
  markIngestStageDispatchFailed,
  registerIngestStageDispatchOutbox,
  type IngestStageDispatchOutboxRow,
} from "./outbox";

/** The minimal Queue producer surface the dispatcher needs. */
export interface IngestStageQueueSender {
  send(body: IngestStageQueueMessage, options?: { contentType?: string; delaySeconds?: number }): Promise<unknown>;
}

export interface DispatchIngestStagePassInput {
  ingestDb: D1RuntimeDatabase;
  queue: IngestStageQueueSender;
  stage: IngestStage;
  workerId: string;
  limit: number;
  leaseSeconds: number;
  now: string;
}

export interface DispatchIngestStagePassResult {
  stage: IngestStage;
  claimed: number;
  enqueued: number;
  failed: number;
  jobIds: string[];
}

function messageForJob(job: IngestStageJobRow, now: string): IngestStageQueueMessage {
  if (!job.claimed_fencing_token) throw new Error("ingest_stage.claimed_without_fence");
  return buildIngestStageQueueMessage({
    stage: job.stage,
    jobId: job.id,
    articleId: job.article_id,
    sourceVersion: job.source_version,
    contentHash: job.content_hash,
    fencingToken: job.claimed_fencing_token,
    enqueuedAt: now,
  });
}

/**
 * Runs one bounded dispatch pass for one stage. On a Queue send failure the job
 * is released back to `pending` (bounded retry) and the outbox row is marked
 * failed, so neither the job nor the outbox is stuck leased.
 *
 * IMPORTANT: the dispatcher never marks a job `succeeded`. Enqueueing a message
 * only moves the job from `pending` to `leased`; the *consumer* is the sole
 * owner of a durable completion (see `consumeIngestStageBatch`). An outbox row
 * that is already `dispatched` under the current fence is left alone (the
 * message is in flight); a row dispatched under an older fence is re-armed and
 * re-sent because the previous lease was superseded.
 */
export async function dispatchIngestStagePass(
  input: DispatchIngestStagePassInput,
): Promise<DispatchIngestStagePassResult> {
  const claimed = await claimIngestStageJobs(input.ingestDb, {
    stage: input.stage,
    workerId: input.workerId,
    limit: input.limit,
    leaseSeconds: input.leaseSeconds,
    now: input.now,
  });
  const queueName = INGEST_STAGE_QUEUES[input.stage];
  const result: DispatchIngestStagePassResult = {
    stage: input.stage,
    claimed: claimed.length,
    enqueued: 0,
    failed: 0,
    jobIds: claimed.map((job) => job.id),
  };
  for (const job of claimed) {
    const message = messageForJob(job, input.now);
    const outbox = await registerIngestStageDispatchOutbox(input.ingestDb, {
      jobId: job.id,
      queueName,
      message,
      now: input.now,
    });
    // Already dispatched under this exact fencing token: the message is in flight
    // and the consumer owns completion. Never complete the job from the producer.
    if (outbox.status === "dispatched") continue;
    try {
      await input.queue.send(message, { contentType: "json" });
      await markIngestStageDispatchDispatched(input.ingestDb, { messageId: outbox.message_id, now: input.now });
      await appendIngestStageEvent(input.ingestDb, {
        jobId: job.id,
        stage: input.stage,
        eventType: "job_dispatched",
        fencingToken: job.claimed_fencing_token,
        safeDetails: { queue: queueName },
        occurredAt: input.now,
      });
      result.enqueued += 1;
    } catch (error) {
      result.failed += 1;
      const code = error instanceof Error ? error.message.slice(0, 120) : "ingest_stage.enqueue_failed";
      await markIngestStageDispatchFailed(input.ingestDb, {
        messageId: outbox.message_id,
        errorCode: code,
        now: input.now,
      });
      if (job.claimed_fencing_token) {
        await failIngestStageJob(input.ingestDb, {
          jobId: job.id,
          fencingToken: job.claimed_fencing_token,
          stage: input.stage,
          errorCode: code,
          retry: true,
          now: input.now,
        });
      }
    }
  }
  return result;
}

/**
 * Replays durable dispatch outbox entries whose Queue send did not complete.
 * The physical queue is resolved per entry from its own stage — a discovery
 * entry can never be re-sent to the crawl queue. Idempotent: a re-send of the
 * same deterministic message identity is harmless because consumers re-read the
 * job row and only act while they hold the matching lease.
 */
export async function reconcileIngestStageDispatch(input: {
  ingestDb: D1RuntimeDatabase;
  queueFor: (stage: IngestStage) => IngestStageQueueSender;
  limit: number;
  now: string;
}): Promise<{ scanned: number; resent: number; failed: number }> {
  const pending: IngestStageDispatchOutboxRow[] = await listPendingIngestStageDispatch(input.ingestDb, {
    limit: input.limit,
    now: input.now,
  });
  let resent = 0;
  let failed = 0;
  for (const entry of pending) {
    const message = JSON.parse(entry.payload) as IngestStageQueueMessage;
    try {
      await input.queueFor(message.stage).send(message, { contentType: "json" });
      await markIngestStageDispatchDispatched(input.ingestDb, { messageId: entry.message_id, now: input.now });
      resent += 1;
    } catch (error) {
      failed += 1;
      const code = error instanceof Error ? error.message.slice(0, 120) : "ingest_stage.enqueue_failed";
      await markIngestStageDispatchFailed(input.ingestDb, {
        messageId: entry.message_id,
        errorCode: code,
        now: input.now,
      });
    }
  }
  return { scanned: pending.length, resent, failed };
}

export interface CompleteStageInput {
  ingestDb: D1RuntimeDatabase;
  jobId: string;
  fencingToken: string;
  resultRef?: string | null;
  /**
   * The canonical core article id the next stage must address, when this stage
   * *resolves* an identity that differs from the incoming job's `article_id`.
   *
   * This is the normalize fix: discovery/crawl jobs carry a `native:` candidate
   * id, but persistence creates a real `worldcons_core.articles.id` (a UUID).
   * Adopting that verified core id for the next job (and recording the mapping
   * in the advance event) is what makes translate/public-judgment/publish/search
   * address the *actual* article instead of a candidate hash. It is only ever a
   * forward mapping recorded by the stage that performed the durable write; a
   * stage that does not change identity leaves it `undefined` and the next job
   * inherits the current `article_id` unchanged.
   */
  nextArticleId?: string;
  /** The next stage's source version/content hash, when the stage changes them. */
  nextSourceVersion?: string;
  nextContentHash?: string;
  /** Optional opaque payload reference (for example an R2 candidate pointer) for the next job. */
  nextPayloadRef?: string | null;
  /**
   * When explicitly `false`, the current job is completed but the next stage's
   * job is intentionally NOT registered. The consumer sets this when the next
   * stage has no wired handler, so a completed stage never fabricates a
   * downstream job that this deployment cannot process (fail closed, not a
   * half-registered pipeline). Defaults to `true`.
   */
  registerNext?: boolean;
  now: string;
}

/**
 * Completes a succeeded stage and (unless suppressed) registers the next stage's
 * job (in the same ingest DB, so no cross-DB transaction is involved). The next
 * registration is idempotent by its own `(articleId, nextStage, sourceVersion,
 * contentHash)` key, so a replayed completion never creates a duplicate
 * downstream job.
 *
 * Completion requires the exact fencing token of the current lease: a stale
 * worker whose lease expired returns `completed: false` and the caller must not
 * ack the message.
 *
 * Returns the next job id and stage, or `null` next stage at the end of the
 * pipeline (or when registration was suppressed).
 */
export async function completeStageAndRegisterNext(
  input: CompleteStageInput,
): Promise<{ completed: boolean; nextStage: IngestStage | null; nextJobId: string | null }> {
  const job = await getIngestStageJobById(input.ingestDb, input.jobId);
  if (!job || job.status !== "leased" || job.claimed_fencing_token !== input.fencingToken
      || !job.lease_expires_at || job.lease_expires_at <= input.now) {
    return { completed: false, nextStage: null, nextJobId: null };
  }
  if (!input.ingestDb.batch) {
    // Completing the parent and inserting the child as separate writes has a
    // crash window that irreversibly loses the downstream stage. Fail closed.
    throw new Error("ingest_stage.atomic_batch_required");
  }
  const nextStage = input.registerNext === false ? null : INGEST_STAGE_NEXT[job.stage];
  const nextArticleId = input.nextArticleId?.trim() || job.article_id;
  // Cloudflare D1 batch is a single transaction: either the parent completes
  // AND the child is recorded, or both roll back on any SQL error.
  const statements: D1RuntimePreparedStatement[] = [
    input.ingestDb.prepare(
      `UPDATE ingest_stage_jobs
          SET status = 'succeeded', result_ref = ?, lease_expires_at = NULL,
              completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'leased' AND claimed_fencing_token = ?
          AND lease_expires_at > ?`,
    ).bind(input.resultRef ?? null, input.now, input.now, job.id, input.fencingToken, input.now),
  ];
  let nextKey: string | null = null;
  if (nextStage) {
    const nextSourceVersion = input.nextSourceVersion ?? job.source_version;
    const nextContentHash = input.nextContentHash ?? job.content_hash;
    nextKey = buildIngestStageIdempotencyKey({
      articleId: nextArticleId, stage: nextStage,
      sourceVersion: nextSourceVersion, contentHash: nextContentHash,
    });
    // INSERT SELECT is guarded by the completed row's fencing token and
    // idempotent on the child key; a competing stale consumer inserts nothing.
    statements.push(input.ingestDb.prepare(
      `INSERT INTO ingest_stage_jobs
         (id, idempotency_key, stage, article_id, source_key, source_version,
          content_hash, status, priority, attempt_count, max_attempts,
          next_attempt_at, payload_ref, created_at, updated_at)
       SELECT ?, ?, ?, ?, source_key, ?, ?, 'pending', 0, 0, ?, ?, ?, ?, ?
         FROM ingest_stage_jobs
        WHERE id = ? AND status = 'succeeded' AND claimed_fencing_token = ?
       ON CONFLICT(idempotency_key) DO NOTHING`,
    ).bind(
      newIngestStageId(), nextKey, nextStage, nextArticleId,
      nextSourceVersion, nextContentHash, INGEST_STAGE_MAX_ATTEMPTS,
      input.now, input.nextPayloadRef ?? null, input.now, input.now,
      job.id, input.fencingToken,
    ));
  }
  statements.push(input.ingestDb.prepare(
    `INSERT INTO ingest_stage_job_events
       (id, job_id, attempt_id, event_type, stage, fencing_token, safe_details, occurred_at)
     SELECT ?, ?, ?, 'job_succeeded', ?, ?, '{}', ?
       FROM ingest_stage_jobs
      WHERE id = ? AND status = 'succeeded' AND claimed_fencing_token = ?
     ON CONFLICT(id) DO NOTHING`,
  ).bind(
    "job-succeeded:" + job.id + ":" + input.fencingToken,
    job.id, job.claimed_attempt_id, job.stage, input.fencingToken, input.now,
    job.id, input.fencingToken,
  ));
  if (nextStage && nextKey) {
    statements.push(input.ingestDb.prepare(
      `INSERT INTO ingest_stage_job_events
         (id, job_id, attempt_id, event_type, stage, fencing_token, safe_details, occurred_at)
       SELECT ?, ?, ?, 'job_stage_advanced', ?, ?, ?, ?
         FROM ingest_stage_jobs
        WHERE id = ? AND status = 'succeeded' AND claimed_fencing_token = ?
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      "job-advanced:" + job.id + ":" + input.fencingToken,
      job.id, job.claimed_attempt_id, job.stage, input.fencingToken,
      JSON.stringify({
        nextStage, nextKey,
        ...(nextArticleId !== job.article_id
          ? { resolvedArticleId: nextArticleId, fromArticleId: job.article_id }
          : {}),
      }),
      input.now, job.id, input.fencingToken,
    ));
  }
  const results = await input.ingestDb.batch(statements);
  if (results.length !== statements.length || results.some((item) => item.success === false || item.error)) {
    throw new Error("ingest_stage.atomic_stage_transition_failed");
  }
  if (results[0]?.meta?.changes !== 1) {
    return { completed: false, nextStage: null, nextJobId: null };
  }
  if (!nextStage || !nextKey) return { completed: true, nextStage: null, nextJobId: null };
  const nextJob = await getIngestStageJobByIdempotencyKey(input.ingestDb, nextKey);
  if (!nextJob) throw new Error("ingest_stage.atomic_next_job_missing");
  return { completed: true, nextStage, nextJobId: nextJob.id };
}
