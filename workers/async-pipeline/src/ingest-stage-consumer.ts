/**
 * Staged-ingestion Queue consumer (M2, corrected M3 semantics).
 *
 * The `worldcons-ingest` Worker owns one consumer per stage queue. A consumer:
 *
 *   1. checks the rollout gate (default OFF, production-only, allowlist-narrowed);
 *   2. validates the ID-only message against the stable contract;
 *   3. re-reads the durable job row (the source of truth) and confirms the
 *      message's idempotency identity and *fencing token* match it, so a forged,
 *      stale or superseded message can never drive or complete work;
 *   4. delegates to a registered per-stage handler.
 *
 * Correctness rules enforced here (audited M0-M2 fixes):
 * - A consumer may only complete a job while the row is still `leased` under the
 *   exact `fencingToken` in the message. If the row is `pending` (a live job
 *   nobody currently owns) the message is retried — never silently acked — so a
 *   fresh dispatch pass can claim it. If the row is already terminal, the message
 *   is ackable (the work is durably done).
 * - A missing handler is fail-closed: the job is moved to `dead_letter` with an
 *   explicit `ingest_stage.handler_missing` code (never false-completed, never
 *   silently acked while still live).
 * - A completion is acked only after the durable `completeStageAndRegisterNext`
 *   reports `completed: true`. The next stage job is only registered when a
 *   handler is actually wired for it, so the pipeline cannot fabricate a
 *   downstream job this deployment cannot process.
 */
import {
  isIngestStageQueueMessage,
  INGEST_STAGE_NEXT,
  type IngestStage,
  type IngestStageQueueMessage,
} from "../../../lib/cloudflare/ingest-stages/contracts";
import { isIngestStageEnabled, type IngestStageRolloutGate } from "../../../lib/cloudflare/ingest-stages/flags";
import {
  completeStageAndRegisterNext,
} from "../../../lib/cloudflare/ingest-stages/dispatcher";
import {
  failIngestStageJob,
  getIngestStageJobById,
  type IngestStageJobRow,
} from "../../../lib/cloudflare/ingest-stages/repository";
import type { D1RuntimeDatabase } from "../../../lib/cloudflare/d1/runtime-binding";

/** A stage handler's bounded outcome. `blocked` is an explicit, terminal, non-retryable block. */
export interface IngestStageHandlerOutcome {
  status: "succeeded" | "retry" | "blocked";
  resultRef?: string | null;
  /**
   * The canonical core article id the next stage must address when this stage
   * resolved an identity different from the incoming job's `article_id` (the
   * normalize stage maps a `native:` candidate id to the real core UUID). When
   * omitted, the next job inherits the current `article_id` unchanged.
   */
  nextArticleId?: string;
  errorCode?: string;
  errorSummary?: string | null;
  nextSourceVersion?: string;
  nextContentHash?: string;
  nextPayloadRef?: string | null;
  /**
   * When `false`, the completed stage does not register a single next-stage job.
   * A fan-out stage (discovery) uses this because it registers its own
   * per-record next jobs directly. Defaults to `true` when a handler for the
   * next stage exists.
   */
  registerNext?: boolean;
}

export interface IngestStageHandlerContext {
  env: unknown;
  ingestDb: D1RuntimeDatabase;
  coreDb: D1RuntimeDatabase;
  message: IngestStageQueueMessage;
  job: IngestStageJobRow;
  now: string;
}

export type IngestStageHandler = (
  context: IngestStageHandlerContext,
) => Promise<IngestStageHandlerOutcome>;

export type IngestStageHandlerRegistry = Partial<Record<IngestStage, IngestStageHandler>>;

/**
 * The pure Queue-batch partition, mirroring the M8 gate decision:
 * - invalid payloads retry (bounded) toward the DLQ;
 * - valid but gate-blocked messages ack without dispatch/processing;
 * - eligible messages are processed by the stage handler.
 */
export interface IngestStageQueuePartition<T> {
  eligible: T[];
  blocked: T[];
  invalid: T[];
}

export function planIngestStageBatch<T>(
  gate: IngestStageRolloutGate,
  messages: readonly T[],
  getBody: (message: T) => unknown,
): IngestStageQueuePartition<T> {
  const partition: IngestStageQueuePartition<T> = { eligible: [], blocked: [], invalid: [] };
  for (const message of messages) {
    const body = getBody(message);
    if (!isIngestStageQueueMessage(body)) {
      partition.invalid.push(message);
    } else if (isIngestStageEnabled(gate, body.stage)) {
      partition.eligible.push(message);
    } else {
      partition.blocked.push(message);
    }
  }
  return partition;
}

export interface IngestStageQueueMessageHandle {
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ConsumeIngestStageBatchDeps {
  gate: IngestStageRolloutGate;
  ingestDb: D1RuntimeDatabase;
  coreDb: D1RuntimeDatabase;
  now: string;
  handlers: IngestStageHandlerRegistry;
  env: unknown;
  invalidRetryDelaySeconds: number;
  /** A clock that can advance per message; defaults to `() => deps.now`. */
  clock?: () => string;
}

export interface ConsumeIngestStageBatchResult {
  eligible: number;
  blocked: number;
  invalid: number;
  processed: number;
  completed: number;
  blockedJobs: number;
  retried: number;
  stale: number;
  ignored: number;
}

/** True when the row is in a terminal state that must never be reprocessed. */
function isTerminal(job: IngestStageJobRow): boolean {
  return job.status === "succeeded" || job.status === "dead_letter" || job.status === "cancelled";
}

/**
 * Consumes one stage queue batch. Malformed -> retry; gate-blocked -> ack;
 * eligible -> re-read the job and run the registered handler under the exact
 * lease. See the module header for the full ack/retry/completion contract.
 */
export async function consumeIngestStageBatch(
  batch: { queue: string; messages: ReadonlyArray<IngestStageQueueMessageHandle> },
  deps: ConsumeIngestStageBatchDeps,
): Promise<ConsumeIngestStageBatchResult> {
  const plan = planIngestStageBatch(deps.gate, batch.messages, (message) => message.body);
  for (const message of plan.invalid) message.retry({ delaySeconds: deps.invalidRetryDelaySeconds });
  for (const message of plan.blocked) message.ack();
  const result: ConsumeIngestStageBatchResult = {
    eligible: plan.eligible.length,
    blocked: plan.blocked.length,
    invalid: plan.invalid.length,
    processed: 0,
    completed: 0,
    blockedJobs: 0,
    retried: 0,
    stale: 0,
    ignored: 0,
  };
  for (const message of plan.eligible) {
    const body = message.body as IngestStageQueueMessage;
    const now = (deps.clock ?? (() => deps.now))();
    const job = await getIngestStageJobById(deps.ingestDb, body.jobId);
    // No durable job: nothing to protect. (A previously-completed job row is
    // never deleted, so this only happens for a phantomed message.)
    if (!job) {
      message.ack();
      result.ignored += 1;
      continue;
    }
    // The message must address the durable job by its own idempotency identity.
    if (job.idempotency_key !== body.idempotencyKey) {
      message.retry({ delaySeconds: deps.invalidRetryDelaySeconds });
      result.retried += 1;
      continue;
    }
    if (isTerminal(job)) {
      message.ack();
      result.ignored += 1;
      continue;
    }
    if (job.status !== "leased") {
      // A live but unowned (pending) job. Do not silently ack: retry so a fresh
      // dispatcher pass can re-lease and deliver it under a current fence.
      message.retry();
      result.stale += 1;
      continue;
    }
    if (job.claimed_fencing_token !== body.fencingToken) {
      // The lease was superseded (or reclaimed) by another owner. This stale
      // delivery must not complete the job; ack it because a newer owner holds
      // the live lease and will process it.
      message.ack();
      result.stale += 1;
      continue;
    }
    const handler = deps.handlers[body.stage];
    if (!handler) {
      // Fail closed, explicitly: record a terminal block and ack. Never a
      // no-op ack that would leave a live leased job silently unresolved.
      await failIngestStageJob(deps.ingestDb, {
        jobId: job.id,
        fencingToken: body.fencingToken,
        stage: body.stage,
        errorCode: "ingest_stage.handler_missing",
        errorSummary: `No consumer handler is registered for stage ${body.stage}.`,
        retry: false,
        now,
      });
      message.ack();
      result.blockedJobs += 1;
      continue;
    }
    const outcome = await handler({
      env: deps.env,
      ingestDb: deps.ingestDb,
      coreDb: deps.coreDb,
      message: body,
      job,
      now,
    });
    result.processed += 1;
    if (outcome.status === "succeeded") {
      const nextStage = INGEST_STAGE_NEXT[body.stage];
      const registerNext = outcome.registerNext !== false && nextStage !== null && Boolean(deps.handlers[nextStage]);
      const advanced = await completeStageAndRegisterNext({
        ingestDb: deps.ingestDb,
        jobId: job.id,
        fencingToken: body.fencingToken,
        resultRef: outcome.resultRef ?? null,
        nextArticleId: outcome.nextArticleId,
        nextSourceVersion: outcome.nextSourceVersion,
        nextContentHash: outcome.nextContentHash,
        nextPayloadRef: outcome.nextPayloadRef,
        registerNext,
        now,
      });
      if (advanced.completed) {
        message.ack();
        result.completed += 1;
      } else {
        // Our lease no longer owns the job (expired/reclaimed). Do not ack.
        const current = await getIngestStageJobById(deps.ingestDb, job.id);
        if (current && isTerminal(current)) {
          message.ack();
          result.ignored += 1;
        } else {
          message.retry();
          result.stale += 1;
        }
      }
      continue;
    }
    if (outcome.status === "retry") {
      await failIngestStageJob(deps.ingestDb, {
        jobId: job.id,
        fencingToken: body.fencingToken,
        stage: body.stage,
        errorCode: outcome.errorCode ?? "ingest_stage.handler_retry",
        errorSummary: outcome.errorSummary ?? null,
        retry: true,
        now,
      });
      message.retry();
      result.retried += 1;
      continue;
    }
    // Explicit terminal block: durably record it, then ack.
    await failIngestStageJob(deps.ingestDb, {
      jobId: job.id,
      fencingToken: body.fencingToken,
      stage: body.stage,
      errorCode: outcome.errorCode ?? "ingest_stage.handler_blocked",
      errorSummary: outcome.errorSummary ?? null,
      retry: false,
      now,
    });
    message.ack();
    result.blockedJobs += 1;
  }
  return result;
}

/** Maps a physical queue name to its stage, or `null` when not a stage queue. */
export function stageForQueueName(queue: string, queueToStage: Readonly<Record<string, IngestStage>>): IngestStage | null {
  return queueToStage[queue] ?? null;
}
