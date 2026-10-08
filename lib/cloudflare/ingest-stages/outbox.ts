/**
 * Durable outboxes for the staged ingestion pipeline (M1).
 *
 * Two independent problems are solved here, both because a single D1 database
 * cannot transact across a physical boundary:
 *
 * 1. `ingest_stage_dispatch_outbox` — a D1 -> Queue enqueue is not atomic with
 *    the job row update. The dispatcher first commits an outbox row (with a
 *    deterministic `message_id`), then enqueues, then marks it dispatched. A
 *    failure leaves a `pending`/`failed` row that a later reconciliation pass
 *    replays; `unique(message_id)` guarantees exactly-once enqueue per job.
 *
 * 2. `ingest_core_bridge_outbox` (ingest) + `ingest_core_bridge_ledger` (core) —
 *    the ingest -> core DB bridge. The ingest DB owns the outbox; applying an
 *    entry writes a core ledger row keyed by the same deterministic
 *    `bridge_key`. Because the ledger insert is `ON CONFLICT DO NOTHING` by that
 *    unique key, applying the same bridge entry twice is a safe no-op.
 */
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import type { IngestStage, IngestStageQueueMessage } from "./contracts";
import { ingestStageQueueMessageId } from "./contracts";

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

function uuid(): string {
  return crypto.randomUUID();
}

/** Reads the fencing token embedded in a stored outbox payload, or `null`. */
function readMessageFencingToken(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { fencingToken?: unknown };
    return typeof parsed.fencingToken === "string" && parsed.fencingToken.length > 0 ? parsed.fencingToken : null;
  } catch {
    return null;
  }
}

export interface IngestStageDispatchOutboxRow {
  id: string;
  job_id: string;
  idempotency_key: string;
  stage: IngestStage;
  queue_name: string;
  message_id: string;
  payload: string;
  status: "pending" | "dispatched" | "failed";
  attempt_count: number;
  next_attempt_at: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  last_error_summary: string | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
}

/**
 * Registers (idempotently) the dispatch outbox entry for a claimed job. The
 * `message_id` is derived deterministically from the message idempotency key, so
 * a re-claim after a crash reuses the same row rather than creating a duplicate
 * queue delivery identity.
 *
 * Because the fencing token lives in the payload and changes on every re-claim,
 * a row that was already `dispatched` under an *older* fence is re-armed
 * (`status='pending'`, new payload) so the current owner can be delivered. A row
 * whose payload already carries the *current* fence is returned unchanged: a
 * re-claim of a job whose message is already in flight must not manufacture a
 * second, conflicting delivery decision.
 */
export async function registerIngestStageDispatchOutbox(
  db: D1RuntimeDatabase,
  input: { jobId: string; queueName: string; message: IngestStageQueueMessage; now: string },
): Promise<IngestStageDispatchOutboxRow> {
  const messageId = await ingestStageQueueMessageId(input.message);
  const existing = await getIngestStageDispatchOutboxByMessageId(db, messageId);
  if (existing) {
    const existingFence = readMessageFencingToken(existing.payload);
    if (existingFence === input.message.fencingToken) return existing;
    // A superseded attempt owns an old payload: refresh it to the current fence.
    // `dispatched`/`failed` rows must become claimable again; a `pending` row is
    // simply updated in place so the newest token is what eventually sends.
    ensureWrite(
      await run(
        db
          .prepare(
            `UPDATE ingest_stage_dispatch_outbox
                SET payload = ?,
                    status = 'pending',
                    dispatched_at = NULL,
                    next_attempt_at = ?,
                    last_error_code = NULL,
                    last_error_summary = NULL,
                    updated_at = ?
              WHERE message_id = ?`,
          )
          .bind(JSON.stringify(input.message), input.now, input.now, messageId),
      ),
    );
    const refreshed = await getIngestStageDispatchOutboxByMessageId(db, messageId);
    if (!refreshed) throw new Error("ingest_stage.dispatch_outbox_rearm_failed");
    return refreshed;
  }
  const id = uuid();
  ensureWrite(
    await run(
      db
        .prepare(
          `INSERT INTO ingest_stage_dispatch_outbox
            (id, job_id, idempotency_key, stage, queue_name, message_id, payload, status, attempt_count, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
           ON CONFLICT(message_id) DO NOTHING`,
        )
        .bind(
          id,
          input.jobId,
          input.message.idempotencyKey,
          input.message.stage,
          input.queueName,
          messageId,
          JSON.stringify(input.message),
          input.now,
          input.now,
          input.now,
        ),
    ),
  );
  const row = await getIngestStageDispatchOutboxByMessageId(db, messageId);
  if (!row) throw new Error("ingest_stage.dispatch_outbox_register_failed");
  return row;
}

export async function getIngestStageDispatchOutboxByMessageId(
  db: D1RuntimeDatabase,
  messageId: string,
): Promise<IngestStageDispatchOutboxRow | null> {
  const rows = ensureRows(
    await db
      .prepare(`SELECT * FROM ingest_stage_dispatch_outbox WHERE message_id = ? LIMIT 1`)
      .bind(messageId)
      .all<IngestStageDispatchOutboxRow>(),
  );
  return rows[0] ?? null;
}

/**
 * Lists dispatch outbox entries still needing a Queue send: freshly `pending`
 * or `failed` rows whose backoff has elapsed. Bounded and index-driven.
 */
export async function listPendingIngestStageDispatch(
  db: D1RuntimeDatabase,
  input: { limit: number; now: string },
): Promise<IngestStageDispatchOutboxRow[]> {
  const bounded = Math.max(1, Math.min(200, Math.trunc(input.limit)));
  return ensureRows(
    await db
      .prepare(
        `SELECT * FROM ingest_stage_dispatch_outbox
          WHERE status IN ('pending', 'failed')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .bind(input.now, bounded)
      .all<IngestStageDispatchOutboxRow>(),
  );
}

export async function markIngestStageDispatchDispatched(
  db: D1RuntimeDatabase,
  input: { messageId: string; now: string },
): Promise<boolean> {
  const changes = ensureWrite(
    await run(
      db
        .prepare(
          `UPDATE ingest_stage_dispatch_outbox
              SET status = 'dispatched', dispatched_at = ?, updated_at = ?, attempt_count = attempt_count + 1
            WHERE message_id = ? AND status IN ('pending', 'failed')`,
        )
        .bind(input.now, input.now, input.messageId),
    ),
  );
  return changes === 1;
}

export async function markIngestStageDispatchFailed(
  db: D1RuntimeDatabase,
  input: { messageId: string; errorCode: string; errorSummary?: string | null; now: string; backoffSeconds?: number },
): Promise<boolean> {
  const nextAttemptAt = new Date(Date.parse(input.now) + (input.backoffSeconds ?? 60) * 1000).toISOString();
  const changes = ensureWrite(
    await run(
      db
        .prepare(
          `UPDATE ingest_stage_dispatch_outbox
              SET status = 'failed',
                  attempt_count = attempt_count + 1,
                  next_attempt_at = ?,
                  last_error_code = ?,
                  last_error_summary = ?,
                  updated_at = ?
            WHERE message_id = ? AND status IN ('pending', 'failed')`,
        )
        .bind(nextAttemptAt, input.errorCode, input.errorSummary ?? null, input.now, input.messageId),
    ),
  );
  return changes === 1;
}

export interface IngestCoreBridgeOutboxRow {
  id: string;
  bridge_key: string;
  job_id: string;
  source_key: string | null;
  article_id: string;
  operation: string;
  payload: string;
  status: "pending" | "applied" | "failed";
  attempt_count: number;
  next_attempt_at: string | null;
  lease_expires_at: string | null;
  fencing_token: string | null;
  last_error_code: string | null;
  last_error_summary: string | null;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
}

/**
 * A deterministic bridge key. Re-running a bridge enqueue for the same
 * `(articleId, operation, sourceVersion, contentHash)` yields the same key, so
 * the ingest outbox row and — crucially — the core ledger row are shared.
 */
export function buildIngestCoreBridgeKey(input: {
  articleId: string;
  operation: string;
  sourceVersion: string;
  contentHash: string;
}): string {
  return ["ingest-bridge", input.articleId, input.operation, input.sourceVersion, input.contentHash].join("\u001f");
}

export async function registerIngestCoreBridgeOutbox(
  db: D1RuntimeDatabase,
  input: {
    bridgeKey: string;
    jobId: string;
    sourceKey?: string | null;
    articleId: string;
    operation: string;
    payload?: Record<string, unknown>;
    now: string;
  },
): Promise<IngestCoreBridgeOutboxRow> {
  const existing = await getIngestCoreBridgeOutboxByKey(db, input.bridgeKey);
  if (existing) return existing;
  const id = uuid();
  ensureWrite(
    await run(
      db
        .prepare(
          `INSERT INTO ingest_core_bridge_outbox
            (id, bridge_key, job_id, source_key, article_id, operation, payload, status, attempt_count, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
           ON CONFLICT(bridge_key) DO NOTHING`,
        )
        .bind(
          id,
          input.bridgeKey,
          input.jobId,
          input.sourceKey ?? null,
          input.articleId,
          input.operation,
          JSON.stringify(input.payload ?? {}),
          input.now,
          input.now,
          input.now,
        ),
    ),
  );
  const row = await getIngestCoreBridgeOutboxByKey(db, input.bridgeKey);
  if (!row) throw new Error("ingest_stage.bridge_outbox_register_failed");
  return row;
}

export async function getIngestCoreBridgeOutboxByKey(
  db: D1RuntimeDatabase,
  bridgeKey: string,
): Promise<IngestCoreBridgeOutboxRow | null> {
  const rows = ensureRows(
    await db
      .prepare(`SELECT * FROM ingest_core_bridge_outbox WHERE bridge_key = ? LIMIT 1`)
      .bind(bridgeKey)
      .all<IngestCoreBridgeOutboxRow>(),
  );
  return rows[0] ?? null;
}

export async function listPendingIngestCoreBridge(
  db: D1RuntimeDatabase,
  input: { limit: number; now: string },
): Promise<IngestCoreBridgeOutboxRow[]> {
  const bounded = Math.max(1, Math.min(200, Math.trunc(input.limit)));
  return ensureRows(
    await db
      .prepare(
        `SELECT * FROM ingest_core_bridge_outbox
          WHERE status IN ('pending', 'failed')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .bind(input.now, bounded)
      .all<IngestCoreBridgeOutboxRow>(),
  );
}

export async function markIngestCoreBridgeApplied(
  db: D1RuntimeDatabase,
  input: { bridgeKey: string; now: string },
): Promise<boolean> {
  const changes = ensureWrite(
    await run(
      db
        .prepare(
          `UPDATE ingest_core_bridge_outbox
              SET status = 'applied', applied_at = ?, updated_at = ?, attempt_count = attempt_count + 1
            WHERE bridge_key = ? AND status IN ('pending', 'failed')`,
        )
        .bind(input.now, input.now, input.bridgeKey),
    ),
  );
  return changes === 1;
}

export async function markIngestCoreBridgeFailed(
  db: D1RuntimeDatabase,
  input: { bridgeKey: string; errorCode: string; errorSummary?: string | null; now: string; backoffSeconds?: number },
): Promise<boolean> {
  const nextAttemptAt = new Date(Date.parse(input.now) + (input.backoffSeconds ?? 60) * 1000).toISOString();
  const changes = ensureWrite(
    await run(
      db
        .prepare(
          `UPDATE ingest_core_bridge_outbox
              SET status = 'failed',
                  attempt_count = attempt_count + 1,
                  next_attempt_at = ?,
                  last_error_code = ?,
                  last_error_summary = ?,
                  updated_at = ?
            WHERE bridge_key = ? AND status IN ('pending', 'failed')`,
        )
        .bind(nextAttemptAt, input.errorCode, input.errorSummary ?? null, input.now, input.bridgeKey),
    ),
  );
  return changes === 1;
}

/**
 * Applies one bridge entry on the `worldcons_core` database. The core ledger's
 * `unique(bridge_key)` is the idempotency guard: a re-apply inserts nothing and
 * reports `alreadyApplied`, so a replay after a crash between the core write and
 * the ingest outbox update is safe.
 *
 * The `effect` callback performs the actual core write and must itself be
 * idempotent for the same key; it is only invoked when the ledger has no row.
 */
export async function applyIngestCoreBridgeOnCore(
  core: D1RuntimeDatabase,
  input: {
    bridgeKey: string;
    jobId: string;
    sourceKey?: string | null;
    articleId: string;
    operation: string;
    payloadHash: string;
    now: string;
    effect?: (core: D1RuntimeDatabase) => Promise<{ resultRef?: string | null } | void> | { resultRef?: string | null } | void;
  },
): Promise<{ applied: boolean; alreadyApplied: boolean; resultRef: string | null }> {
  const existing = ensureRows(
    await core
      .prepare(`SELECT id, result_ref FROM ingest_core_bridge_ledger WHERE bridge_key = ? LIMIT 1`)
      .bind(input.bridgeKey)
      .all<{ id: string; result_ref: string | null }>(),
  );
  if (existing[0]) {
    return { applied: false, alreadyApplied: true, resultRef: existing[0].result_ref ?? null };
  }
  const result = input.effect ? await input.effect(core) : undefined;
  const resultRef = result?.resultRef ?? null;
  ensureWrite(
    await run(
      core
        .prepare(
          `INSERT INTO ingest_core_bridge_ledger
            (id, bridge_key, job_id, source_key, article_id, operation, payload_hash, result_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(bridge_key) DO NOTHING`,
        )
        .bind(
          uuid(),
          input.bridgeKey,
          input.jobId,
          input.sourceKey ?? null,
          input.articleId,
          input.operation,
          input.payloadHash,
          resultRef,
          input.now,
        ),
    ),
  );
  const after = ensureRows(
    await core
      .prepare(`SELECT result_ref FROM ingest_core_bridge_ledger WHERE bridge_key = ? LIMIT 1`)
      .bind(input.bridgeKey)
      .all<{ result_ref: string | null }>(),
  );
  return { applied: true, alreadyApplied: false, resultRef: after[0]?.result_ref ?? resultRef };
}
