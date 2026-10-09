import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  INGEST_STAGE_NEXT,
  INGEST_STAGE_QUEUES,
  buildIngestStageIdempotencyKey,
  buildIngestStageQueueMessage,
  ingestStageQueueMessageId,
  isIngestStageQueueMessage,
  parseIngestStageIdempotencyKey,
  type IngestStage,
  type IngestStageQueueMessage,
} from "../lib/cloudflare/ingest-stages/contracts";
import {
  ingestStageFlagErrors,
  ingestStageGateFromEnvironment,
  isIngestStageEnabled,
  parseIngestStageAllowlist,
  resolveIngestStageRolloutGate,
  resolveIngestBootstrapSources,
} from "../lib/cloudflare/ingest-stages/flags";
import {
  claimIngestStageJobs,
  completeIngestStageJob,
  failIngestStageJob,
  getIngestStageJobById,
  getIngestStageJobByIdempotencyKey,
  registerIngestStageJob,
} from "../lib/cloudflare/ingest-stages/repository";
import {
  applyIngestCoreBridgeOnCore,
  buildIngestCoreBridgeKey,
  getIngestStageDispatchOutboxByMessageId,
  listPendingIngestCoreBridge,
  listPendingIngestStageDispatch,
  markIngestStageDispatchDispatched,
  registerIngestCoreBridgeOutbox,
  registerIngestStageDispatchOutbox,
} from "../lib/cloudflare/ingest-stages/outbox";
import {
  completeStageAndRegisterNext,
  dispatchIngestStagePass,
  reconcileIngestStageDispatch,
  type IngestStageQueueSender,
} from "../lib/cloudflare/ingest-stages/dispatcher";
import {
  consumeIngestStageBatch,
  planIngestStageBatch,
} from "../workers/async-pipeline/src/ingest-stage-consumer";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";
import {
  buildD1RemoteMigrations,
  parseD1MigrationVerifyDirectives,
  type D1MigrationSourceFile,
} from "../lib/cloudflare/d1/remote";
import type { D1Database } from "../lib/cloudflare/d1/types";
import fs from "node:fs";
import path from "node:path";

const NOW = "2026-10-08T00:00:00.000Z";
const INGEST_SCHEMA = fs.readFileSync(path.join(process.cwd(), "d1", "worldcons_ingest", "0003_ingest_stage_jobs.sql"), "utf8");
const CORE_SCHEMA = fs.readFileSync(path.join(process.cwd(), "d1", "worldcons_core", "0003_ingest_core_bridge_ledger.sql"), "utf8");

function binding(database: DatabaseSync): D1RuntimeDatabase {
  return {
    prepare(sql: string): D1RuntimePreparedStatement {
      let values: unknown[] = [];
      const prepared: D1RuntimePreparedStatement = {
        bind(...next: unknown[]) {
          values = next;
          return prepared;
        },
        async all<T>() {
          try {
            const rows = database.prepare(sql).all(...(values as SQLInputValue[])) as T[];
            return { success: true, results: rows };
          } catch (error) {
            return { success: false, results: [], error: error instanceof Error ? error.message : String(error) };
          }
        },
        async run() {
          try {
            const result = database.prepare(sql).run(...(values as SQLInputValue[]));
            return { success: true, results: [], meta: { changes: Number(result.changes) } };
          } catch (error) {
            return { success: false, results: [], error: error instanceof Error ? error.message : String(error) };
          }
        },
      };
      return prepared;
    },
    async batch(statements: D1RuntimePreparedStatement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) {
          if (!statement.run) throw new Error("test.batch_statement_not_runnable");
          const result = await statement.run();
          if (result.success === false || result.error) {
            throw new Error(result.error ?? "test.batch_statement_failed");
          }
          results.push(result);
        }
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function createDatabases() {
  const ingest = new DatabaseSync(":memory:");
  const core = new DatabaseSync(":memory:");
  ingest.exec(INGEST_SCHEMA);
  core.exec(CORE_SCHEMA);
  return { ingest, core };
}

function queueSender(fail = false): { sender: IngestStageQueueSender; sent: IngestStageQueueMessage[] } {
  const sent: IngestStageQueueMessage[] = [];
  const sender: IngestStageQueueSender = {
    async send(body) {
      if (fail) throw new Error("queue.down");
      sent.push(body);
      return { ok: true };
    },
  };
  return { sender, sent };
}

test("idempotency key is stable, round-trips, and rejects forgery", () => {
  const input = { articleId: "article-1", stage: "crawl" as IngestStage, sourceVersion: "2026-10-08", contentHash: "abc123" };
  const key = buildIngestStageIdempotencyKey(input);
  assert.deepEqual(parseIngestStageIdempotencyKey(key), input);
  assert.equal(buildIngestStageIdempotencyKey(JSON.parse(JSON.stringify(input))), key);
  // colon/pipe in fields cannot collide because the separator is a unit separator
  const tricky = buildIngestStageIdempotencyKey({ articleId: "a:b|c", stage: "crawl", sourceVersion: "s", contentHash: "h" });
  assert.deepEqual(parseIngestStageIdempotencyKey(tricky), { articleId: "a:b|c", stage: "crawl", sourceVersion: "s", contentHash: "h" });
  assert.equal(parseIngestStageIdempotencyKey("not-a-key"), null);
  assert.equal(parseIngestStageIdempotencyKey(key.replace("crawl", "bogus")), null);
});

test("queue message validation accepts built messages and rejects forged keys", async () => {
  const message = buildIngestStageQueueMessage({
    stage: "normalize",
    jobId: "job-1",
    articleId: "article-1",
    sourceVersion: "v1",
    contentHash: "hash1",
    fencingToken: "1",
    enqueuedAt: NOW,
  });
  assert.ok(isIngestStageQueueMessage(message));
  assert.ok(isIngestStageQueueMessage(JSON.parse(JSON.stringify(message))));
  assert.equal(isIngestStageQueueMessage({ ...message, idempotencyKey: "forged" }), false);
  assert.equal(isIngestStageQueueMessage({ ...message, schemaVersion: 2 }), false);
  assert.equal(isIngestStageQueueMessage({ ...message, fencingToken: "" }), false);
  assert.equal(isIngestStageQueueMessage({ ...message, stage: "bogus" }), false);
  assert.equal(isIngestStageQueueMessage({ ...message, articleId: "" }), false);
  assert.equal(isIngestStageQueueMessage({ ...message, enqueuedAt: "not-a-time" }), false);
  assert.equal(isIngestStageQueueMessage(null), false);
  assert.ok((await ingestStageQueueMessageId(message)).length <= 100);
  assert.ok(/^[a-zA-Z0-9_-]+$/.test(await ingestStageQueueMessageId(message)));
  // The content hash and revision are at the *end* of the long canonical key:
  // a truncate-first implementation once merged both messages into one outbox.
  const tomorrow = buildIngestStageQueueMessage({
    stage: "discovery",
    jobId: "j2",
    articleId: "native-discovery:fr-conseil-constitutionnel:20:default",
    sourceVersion: "discovery-request-v1:2026-10-09",
    contentHash: "abc".repeat(24),
    fencingToken: "1",
    enqueuedAt: NOW,
  });
  const yesterday = { ...tomorrow, idempotencyKey: buildIngestStageIdempotencyKey({
    articleId: tomorrow.articleId, stage: "discovery",
    sourceVersion: "discovery-request-v1:2026-10-08", contentHash: tomorrow.contentHash,
  }) };
  assert.notEqual(await ingestStageQueueMessageId(yesterday), await ingestStageQueueMessageId(tomorrow));
});

test("stage map: every stage has a queue and a well-formed next-stage transition", () => {
  const stages = Object.keys(INGEST_STAGE_NEXT) as IngestStage[];
  for (const stage of stages) {
    assert.ok(INGEST_STAGE_QUEUES[stage].startsWith("worldcons-stage-"), `${stage} has a queue`);
  }
  assert.equal(INGEST_STAGE_NEXT.search, null);
  assert.equal(INGEST_STAGE_NEXT.discovery, "crawl");
  assert.equal(INGEST_STAGE_NEXT.translate, "public-judgment");
  assert.equal(INGEST_STAGE_NEXT.publish, "search");
});

test("feature flags default OFF and fail closed", () => {
  assert.equal(ingestStageGateFromEnvironment({}).masterEnabled, false);
  assert.equal(isIngestStageEnabled(ingestStageGateFromEnvironment({}), "crawl"), false);

  // master on, production, valid allowlist => enabled
  const on = resolveIngestStageRolloutGate(true, "production", "crawl,normalize");
  assert.equal(isIngestStageEnabled(on, "crawl"), true);
  assert.equal(isIngestStageEnabled(on, "translation" as unknown as IngestStage), false);
  assert.equal(isIngestStageEnabled(on, "translate"), false);

  // not production => denied even with master on
  assert.equal(isIngestStageEnabled(resolveIngestStageRolloutGate(true, "staging", "*"), "crawl"), false);
  assert.equal(isIngestStageEnabled(resolveIngestStageRolloutGate(true, undefined, "*"), "crawl"), false);

  // empty/invalid allowlist => denied
  assert.equal(isIngestStageEnabled(resolveIngestStageRolloutGate(true, "production", ""), "crawl"), false);
  assert.equal(isIngestStageEnabled(resolveIngestStageRolloutGate(true, "production", "bogus"), "crawl"), false);

  // wildcard alone => all stages
  const any = resolveIngestStageRolloutGate(true, "production", "*");
  assert.equal(isIngestStageEnabled(any, "search"), true);

  // wildcard mixed with a stage => invalid
  assert.equal(parseIngestStageAllowlist("*,crawl").valid, false);

  // errors surface misconfiguration
  assert.equal(ingestStageFlagErrors({ WORLDCONS_INGEST_STAGES_ENABLED: "true" }).length, 2);
  assert.equal(
    ingestStageFlagErrors({
      WORLDCONS_INGEST_STAGES_ENABLED: "true",
      WORLDCONS_INGEST_STAGE_ENVIRONMENT: "production",
      WORLDCONS_INGEST_STAGE_ALLOWLIST: "crawl",
    }).length,
    0,
  );
});

test("production stage bootstrap is restricted to explicit verified canary sources", () => {
  const sources = ["us-scotus", "fr-conseil-constitutionnel"];
  assert.deepEqual(resolveIngestBootstrapSources(undefined, sources), []);
  assert.deepEqual(resolveIngestBootstrapSources("", sources), []);
  assert.deepEqual(resolveIngestBootstrapSources("invalid-source", sources), []);
  assert.deepEqual(resolveIngestBootstrapSources("fr-conseil-constitutionnel,invalid-source", sources), []);
  assert.deepEqual(resolveIngestBootstrapSources("fr-conseil-constitutionnel,fr-conseil-constitutionnel", sources), ["fr-conseil-constitutionnel"]);
});

test("register is idempotent by idempotency key", async () => {
  const db = createDatabases();
  const ingestDb = binding(db.ingest);
  try {
    const first = await registerIngestStageJob(ingestDb, {
      stage: "crawl", articleId: "a1", sourceKey: "de-bverfg", sourceVersion: "v1", contentHash: "h1", now: NOW,
    });
    assert.equal(first.created, true);
    const second = await registerIngestStageJob(ingestDb, {
      stage: "crawl", articleId: "a1", sourceKey: "de-bverfg", sourceVersion: "v1", contentHash: "h1", now: "2026-10-08T01:00:00.000Z",
    });
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    const key = buildIngestStageIdempotencyKey({ articleId: "a1", stage: "crawl", sourceVersion: "v1", contentHash: "h1" });
    const byKey = await getIngestStageJobByIdempotencyKey(ingestDb, key);
    assert.equal(byKey?.id, first.job.id);
  } finally {
    db.ingest.close(); db.core.close();
  }
});

test("claim is bounded, fenced, and rejects a stale fencing token", async () => {
  const db = createDatabases();
  const ingestDb = binding(db.ingest);
  try {
    for (let i = 0; i < 3; i += 1) {
      await registerIngestStageJob(ingestDb, { stage: "crawl", articleId: `a${i}`, sourceVersion: "v1", contentHash: `h${i}`, now: NOW });
    }
    const claimed = await claimIngestStageJobs(ingestDb, { stage: "crawl", workerId: "w1", limit: 2, leaseSeconds: 300, now: NOW });
    assert.equal(claimed.length, 2);
    assert.ok(claimed.every((job) => job.status === "leased" && job.claimed_fencing_token === "1"));

    // A second dispatcher cannot steal the still-leased rows.
    const second = await claimIngestStageJobs(ingestDb, { stage: "crawl", workerId: "w2", limit: 5, leaseSeconds: 300, now: NOW });
    assert.equal(second.length, 1);

    // Wrong fence cannot complete.
    const wrong = await completeIngestStageJob(ingestDb, { jobId: claimed[0].id, fencingToken: "999", stage: "crawl", now: NOW });
    assert.equal(wrong, false);
    const right = await completeIngestStageJob(ingestDb, { jobId: claimed[0].id, fencingToken: claimed[0].claimed_fencing_token as string, stage: "crawl", now: NOW });
    assert.equal(right, true);
    const row = await getIngestStageJobById(ingestDb, claimed[0].id);
    assert.equal(row?.status, "succeeded");
  } finally {
    db.ingest.close(); db.core.close();
  }
});

test("an expired lease is reclaimable with a bumped fencing token", async () => {
  const db = createDatabases();
  const ingestDb = binding(db.ingest);
  try {
    await registerIngestStageJob(ingestDb, { stage: "normalize", articleId: "a1", sourceVersion: "v1", contentHash: "h1", now: NOW });
    const [claimed] = await claimIngestStageJobs(ingestDb, { stage: "normalize", workerId: "w1", limit: 1, leaseSeconds: 1, now: NOW });
    assert.equal(claimed.claimed_fencing_token, "1");
    const later = "2026-10-08T01:00:00.000Z";
    const [reclaimed] = await claimIngestStageJobs(ingestDb, { stage: "normalize", workerId: "w2", limit: 1, leaseSeconds: 300, now: later });
    assert.equal(reclaimed.id, claimed.id);
    assert.equal(reclaimed.claimed_fencing_token, "2");
    // The stale token can no longer complete the job.
    assert.equal(
      await completeIngestStageJob(ingestDb, { jobId: claimed.id, fencingToken: "1", stage: "normalize", now: later }),
      false,
    );
  } finally {
    db.ingest.close(); db.core.close();
  }
});

test("a repeatedly crashing consumer is dead-lettered at the attempt budget, not re-leased forever", async () => {
  const db = createDatabases();
  const ingestDb = binding(db.ingest);
  try {
    const { job } = await registerIngestStageJob(ingestDb, {
      stage: "translate", articleId: "crash-loop", sourceVersion: "v1", contentHash: "h1", now: NOW,
    });
    db.ingest.prepare("UPDATE ingest_stage_jobs SET max_attempts=1 WHERE id=?").run(job.id);
    const [first] = await claimIngestStageJobs(ingestDb, {
      stage: "translate", workerId: "worker-crashes", limit: 1, leaseSeconds: 1, now: NOW,
    });
    assert.equal(first.attempt_count, 1);
    const later = new Date(Date.parse(NOW) + 60_000).toISOString();
    const reclaimed = await claimIngestStageJobs(ingestDb, {
      stage: "translate", workerId: "other-worker", limit: 1, leaseSeconds: 1, now: later,
    });
    assert.equal(reclaimed.length, 0, "attempt-exhausted jobs must never be re-leased");
    const terminal = await getIngestStageJobById(ingestDb, job.id);
    assert.equal(terminal?.status, "dead_letter");
    assert.equal(terminal?.last_error_code, "ingest_stage.lease_attempts_exhausted");
    assert.equal(terminal?.attempt_count, 1);
    assert.equal(db.ingest.prepare("SELECT COUNT(*) AS n FROM ingest_stage_job_events WHERE job_id=? AND event_type='job_dead_lettered'").get(job.id)?.n, 1);
    assert.equal((await claimIngestStageJobs(ingestDb, {
      stage: "translate", workerId: "third-worker", limit: 1, leaseSeconds: 1, now: later,
    })).length, 0, "dead-lettered jobs must stay terminal without operator intervention");
  } finally {
    db.ingest.close(); db.core.close();
  }
});

test("failIngestStageJob retries within budget and dead-letters when exhausted", async () => {
  const db = createDatabases();
  const ingestDb = binding(db.ingest);
  try {
    await registerIngestStageJob(ingestDb, { stage: "translate", articleId: "a1", sourceVersion: "v1", contentHash: "h1", now: NOW });
    const [claimed] = await claimIngestStageJobs(ingestDb, { stage: "translate", workerId: "w1", limit: 1, leaseSeconds: 300, now: NOW });
    const retry = await failIngestStageJob(ingestDb, {
      jobId: claimed.id, fencingToken: claimed.claimed_fencing_token as string, stage: "translate",
      errorCode: "llm.timeout", retry: true, backoffSeconds: 60, now: NOW,
    });
    assert.deepEqual(retry, { status: "pending", attemptCount: 1 });
    const row = await getIngestStageJobById(ingestDb, claimed.id);
    assert.equal(row?.status, "pending");
    assert.equal(row?.next_attempt_at, "2026-10-08T00:01:00.000Z");

    // Terminal failure dead-letters immediately.
    const [again] = await claimIngestStageJobs(ingestDb, { stage: "translate", workerId: "w1", limit: 1, leaseSeconds: 300, now: "2026-10-08T00:02:00.000Z" });
    const dead = await failIngestStageJob(ingestDb, {
      jobId: again.id, fencingToken: again.claimed_fencing_token as string, stage: "translate",
      errorCode: "llm.hard", retry: false, now: "2026-10-08T00:02:00.000Z",
    });
    assert.equal(dead?.status, "dead_letter");
  } finally {
    db.ingest.close(); db.core.close();
  }
});

test("dispatch outbox registration is idempotent by deterministic message id", async () => {
  const db = createDatabases();
  const ingestDb = binding(db.ingest);
  try {
    const message = buildIngestStageQueueMessage({ stage: "crawl", jobId: "j1", articleId: "a1", sourceVersion: "v1", contentHash: "h1", fencingToken: "1", enqueuedAt: NOW });
    const first = await registerIngestStageDispatchOutbox(ingestDb, { jobId: "j1", queueName: INGEST_STAGE_QUEUES.crawl, message, now: NOW });
    const second = await registerIngestStageDispatchOutbox(ingestDb, { jobId: "j1", queueName: INGEST_STAGE_QUEUES.crawl, message, now: NOW });
    assert.equal(second.id, first.id);
    assert.equal((await listPendingIngestStageDispatch(ingestDb, { limit: 10, now: NOW })).length, 1);
    assert.equal(await markIngestStageDispatchDispatched(ingestDb, { messageId: first.message_id, now: NOW }), true);
    assert.equal((await getIngestStageDispatchOutboxByMessageId(ingestDb, first.message_id))?.status, "dispatched");
    assert.equal((await listPendingIngestStageDispatch(ingestDb, { limit: 10, now: NOW })).length, 0);
  } finally {
    db.ingest.close(); db.core.close();
  }
});

test("ingest -> core bridge applies exactly once and is replay-safe", async () => {
  const db = createDatabases();
  const ingestDb = binding(db.ingest);
  const coreDb = binding(db.core);
  try {
    const bridgeKey = buildIngestCoreBridgeKey({ articleId: "a1", operation: "article.upsert", sourceVersion: "v1", contentHash: "h1" });
    await registerIngestCoreBridgeOutbox(ingestDb, { bridgeKey, jobId: "j1", articleId: "a1", operation: "article.upsert", now: NOW });
    assert.equal((await listPendingIngestCoreBridge(ingestDb, { limit: 10, now: NOW })).length, 1);

    let effects = 0;
    const first = await applyIngestCoreBridgeOnCore(coreDb, {
      bridgeKey, jobId: "j1", articleId: "a1", operation: "article.upsert", payloadHash: "ph1", now: NOW,
      effect: () => { effects += 1; return { resultRef: "article-row-1" }; },
    });
    assert.deepEqual(first, { applied: true, alreadyApplied: false, resultRef: "article-row-1" });
    // Replay: the core ledger row already exists, so the effect never runs again.
    const replay = await applyIngestCoreBridgeOnCore(coreDb, {
      bridgeKey, jobId: "j1", articleId: "a1", operation: "article.upsert", payloadHash: "ph1", now: "2026-10-08T02:00:00.000Z",
      effect: () => { effects += 1; return { resultRef: "should-not-run" }; },
    });
    assert.deepEqual(replay, { applied: false, alreadyApplied: true, resultRef: "article-row-1" });
    assert.equal(effects, 1);
  } finally {
    db.ingest.close(); db.core.close();
  }
});

test("dispatcher claims, enqueues once, and records the dispatch outbox", async () => {
  const db = createDatabases();
  const ingestDb = binding(db.ingest);
  try {
    for (let i = 0; i < 2; i += 1) {
      await registerIngestStageJob(ingestDb, { stage: "discovery", articleId: `a${i}`, sourceVersion: "v1", contentHash: `h${i}`, now: NOW });
    }
    const { sender, sent } = queueSender();
    const result = await dispatchIngestStagePass({ ingestDb, queue: sender, stage: "discovery", workerId: "w1", limit: 10, leaseSeconds: 300, now: NOW });
    assert.equal(result.claimed, 2);
    assert.equal(result.enqueued, 2);
    assert.equal(sent.length, 2);
    assert.ok(sent.every((message) => message.stage === "discovery"));

    // Re-running the pass has nothing claimable.
    const again = await dispatchIngestStagePass({ ingestDb, queue: sender, stage: "discovery", workerId: "w1", limit: 10, leaseSeconds: 300, now: NOW });
    assert.equal(again.claimed, 0);
    assert.equal(sent.length, 2);
  } finally {
    db.ingest.close(); db.core.close();
  }
});

test("dispatcher releases the job and marks the outbox failed when the queue is down", async () => {
  const db = createDatabases();
  const ingestDb = binding(db.ingest);
  try {
    const { job } = await registerIngestStageJob(ingestDb, { stage: "publish", articleId: "a1", sourceVersion: "v1", contentHash: "h1", now: NOW });
    const { sender } = queueSender(true);
    const result = await dispatchIngestStagePass({ ingestDb, queue: sender, stage: "publish", workerId: "w1", limit: 1, leaseSeconds: 300, now: NOW });
    assert.equal(result.failed, 1);
    const row = await getIngestStageJobById(ingestDb, job.id);
    assert.equal(row?.status, "pending");
  } finally {
    db.ingest.close(); db.core.close();
  }
});

test("dispatch reconciliation replays a durable pending outbox entry", async () => {
  const db = createDatabases();
  const ingestDb = binding(db.ingest);
  try {
    const message = buildIngestStageQueueMessage({ stage: "search", jobId: "j1", articleId: "a1", sourceVersion: "v1", contentHash: "h1", fencingToken: "1", enqueuedAt: NOW });
    await registerIngestStageDispatchOutbox(ingestDb, { jobId: "j1", queueName: INGEST_STAGE_QUEUES.search, message, now: NOW });
    const { sender, sent } = queueSender();
    const result = await reconcileIngestStageDispatch({ ingestDb, queueFor: () => sender, limit: 10, now: NOW });
    assert.deepEqual(result, { scanned: 1, resent: 1, failed: 0 });
    assert.equal(sent.length, 1);
    assert.equal((await listPendingIngestStageDispatch(ingestDb, { limit: 10, now: NOW })).length, 0);
  } finally {
    db.ingest.close(); db.core.close();
  }
});

test("completeStageAndRegisterNext advances through the pipeline by idempotent next-jobs", async () => {
  const db = createDatabases();
  const ingestDb = binding(db.ingest);
  try {
    const { job } = await registerIngestStageJob(ingestDb, { stage: "crawl", articleId: "a1", sourceVersion: "v1", contentHash: "h1", now: NOW });
    const [claimed] = await claimIngestStageJobs(ingestDb, { stage: "crawl", workerId: "w1", limit: 1, leaseSeconds: 300, now: NOW });
    const advanced = await completeStageAndRegisterNext({
      ingestDb, jobId: claimed.id, fencingToken: claimed.claimed_fencing_token as string, now: NOW,
    });
    assert.equal(advanced.completed, true);
    assert.equal(advanced.nextStage, "normalize");
    assert.ok(advanced.nextJobId);
    const nextRow = await getIngestStageJobById(ingestDb, advanced.nextJobId as string);
    assert.equal(nextRow?.stage, "normalize");
    // Replay is a no-op because the completed job is no longer leased.
    const replay = await completeStageAndRegisterNext({ ingestDb, jobId: job.id, fencingToken: "1", now: NOW });
    assert.equal(replay.completed, false);
  } finally {
    db.ingest.close(); db.core.close();
  }
});

test("atomic stage handoff rolls back parent success when child registration fails", async () => {
  const db = createDatabases();
  const ingestDb = binding(db.ingest);
  try {
    const { job } = await registerIngestStageJob(ingestDb, {
      stage: "crawl", articleId: "crash-case", sourceVersion: "v1", contentHash: "h1", now: NOW,
    });
    const [claimed] = await claimIngestStageJobs(ingestDb, {
      stage: "crawl", workerId: "crash-test", limit: 1, leaseSeconds: 300, now: NOW,
    });
    const failSecondStatement: D1RuntimeDatabase = {
      prepare: (sql) => ingestDb.prepare(sql),
      async batch(statements) {
        const injected = statements.map((statement, index) => index === 1
          ? { ...statement, run: async () => ({ success: false, error: "fault.injected_child_insert" }) }
          : statement);
        if (!ingestDb.batch) throw new Error("test.batch_unavailable");
        return ingestDb.batch(injected);
      },
    };
    await assert.rejects(
      completeStageAndRegisterNext({
        ingestDb: failSecondStatement, jobId: claimed.id,
        fencingToken: claimed.claimed_fencing_token as string, now: NOW,
      }),
      /fault.injected_child_insert/,
    );
    const parent = await getIngestStageJobById(ingestDb, job.id);
    assert.equal(parent?.status, "leased", "failed child insert must roll back the parent success");
    assert.equal(db.ingest.prepare("SELECT COUNT(*) AS n FROM ingest_stage_jobs WHERE stage='normalize'").get()?.n, 0);
    assert.equal(db.ingest.prepare("SELECT COUNT(*) AS n FROM ingest_stage_job_events WHERE event_type='job_succeeded'").get()?.n, 0);

    const recovered = await completeStageAndRegisterNext({
      ingestDb, jobId: claimed.id, fencingToken: claimed.claimed_fencing_token as string, now: NOW,
    });
    assert.equal(recovered.completed, true);
    assert.ok(recovered.nextJobId);
    assert.equal(db.ingest.prepare("SELECT COUNT(*) AS n FROM ingest_stage_jobs WHERE stage='normalize'").get()?.n, 1);
    assert.equal(db.ingest.prepare("SELECT COUNT(*) AS n FROM ingest_stage_job_events WHERE event_type='job_succeeded'").get()?.n, 1);
    assert.equal(db.ingest.prepare("SELECT COUNT(*) AS n FROM ingest_stage_job_events WHERE event_type='job_stage_advanced'").get()?.n, 1);
    const replay = await completeStageAndRegisterNext({
      ingestDb, jobId: claimed.id, fencingToken: claimed.claimed_fencing_token as string, now: NOW,
    });
    assert.equal(replay.completed, false);
    assert.equal(db.ingest.prepare("SELECT COUNT(*) AS n FROM ingest_stage_jobs WHERE stage='normalize'").get()?.n, 1);
  } finally {
    db.ingest.close(); db.core.close();
  }
});

test("stage completion requires an atomic D1 batch and an unexpired lease", async () => {
  const db = createDatabases();
  const ingestDb = binding(db.ingest);
  try {
    const { job } = await registerIngestStageJob(ingestDb, {
      stage: "publish", articleId: "lease-case", sourceVersion: "v1", contentHash: "h1", now: NOW,
    });
    const [claimed] = await claimIngestStageJobs(ingestDb, {
      stage: "publish", workerId: "lease-test", limit: 1, leaseSeconds: 60, now: NOW,
    });
    const noBatch: D1RuntimeDatabase = { prepare: (sql) => ingestDb.prepare(sql) };
    await assert.rejects(completeStageAndRegisterNext({
      ingestDb: noBatch, jobId: claimed.id, fencingToken: claimed.claimed_fencing_token as string, now: NOW,
    }), /ingest_stage.atomic_batch_required/);
    assert.equal((await getIngestStageJobById(ingestDb, job.id))?.status, "leased");

    const expiredAt = new Date(Date.parse(NOW) + 61_000).toISOString();
    const expired = await completeStageAndRegisterNext({
      ingestDb, jobId: claimed.id, fencingToken: claimed.claimed_fencing_token as string, now: expiredAt,
    });
    assert.equal(expired.completed, false);
    assert.equal((await getIngestStageJobById(ingestDb, job.id))?.status, "leased");
    assert.equal(db.ingest.prepare("SELECT COUNT(*) AS n FROM ingest_stage_jobs WHERE stage='search'").get()?.n, 0);
  } finally {
    db.ingest.close(); db.core.close();
  }
});

test("stage migrations are additive, verified, and have no destructive statements", () => {
  const migrations: D1MigrationSourceFile[] = [
    { database: "worldcons_ingest" as D1Database, file: "0003_ingest_stage_jobs.sql", sql: INGEST_SCHEMA },
    { database: "worldcons_core" as D1Database, file: "0003_ingest_core_bridge_ledger.sql", sql: CORE_SCHEMA },
  ];
  const discovered = buildD1RemoteMigrations(migrations);
  assert.deepEqual(
    discovered.map((migration) => `${migration.database}/${migration.id}`),
    ["worldcons_core/0003", "worldcons_ingest/0003"],
  );
  for (const migration of discovered) {
    assert.ok(parseD1MigrationVerifyDirectives(migration.sql).length > 0, `${migration.file} has verify directives`);
    const executable = migration.sql.replace(/--.*$/gm, "");
    for (const forbidden of ["drop table", "delete from", "truncate", "alter table", "pragma"]) {
      assert.ok(!executable.toLowerCase().includes(forbidden), `${migration.file} must not contain ${forbidden}`);
    }
  }
  // The ingest migration declares every stage job/outbox/bridge table.
  for (const table of [
    "ingest_stage_jobs",
    "ingest_stage_job_events",
    "ingest_stage_dispatch_outbox",
    "ingest_core_bridge_outbox",
  ]) {
    assert.match(INGEST_SCHEMA, new RegExp(`create table if not exists ${table}\\b`));
  }
  assert.match(CORE_SCHEMA, /create table if not exists ingest_core_bridge_ledger\b/);
});

test("production canary config bounds two validated sources to one item per dispatch", () => {
  const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), "workers", "async-pipeline", "wrangler.jsonc"), "utf8"));
  assert.equal(config.vars.WORLDCONS_INGEST_STAGES_ENABLED, "true");
  assert.equal(config.vars.WORLDCONS_INGEST_STAGE_ENVIRONMENT, "production");
  assert.equal(config.vars.WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST, "fr-conseil-constitutionnel,es-tribunal-constitucional");
  assert.equal(config.vars.WORLDCONS_INGEST_STAGE_BOOTSTRAP_LIMIT, "1");
  assert.equal(config.vars.WORLDCONS_INGEST_STAGE_DISPATCH_LIMIT, "1");
  assert.ok(parseIngestStageAllowlist(config.vars.WORLDCONS_INGEST_STAGE_ALLOWLIST).valid);
  const stageQueues = config.queues.producers.map((producer: { queue: string }) => producer.queue).filter((queue: string) => queue.startsWith("worldcons-stage-"));
  assert.equal(stageQueues.length, 7);
  const consumers = config.queues.consumers.map((consumer: { queue: string }) => consumer.queue);
  for (const queue of stageQueues) assert.ok(consumers.includes(queue), `${queue} has a consumer`);
  assert.equal(consumers[0], "worldcons-async-v1", "the existing M8 consumer is preserved first");
});

test("the Worker exposes a stage-queue consumer entrypoint without touching the M8 path", () => {
  const worker = fs.readFileSync(path.join(process.cwd(), "workers", "async-pipeline", "src", "index.ts"), "utf8");
  assert.match(worker, /stageForQueue\(batch\.queue\)/);
  assert.match(worker, /consumeIngestStageBatch/);
  assert.match(worker, /ingestStageHandlersFor/);
  assert.match(worker, /createIngestStageHandlers/);
  assert.match(worker, /runIngestStageScheduled/);
  assert.match(worker, /reconcileIngestStageDispatch/);
  // The M8 decision path is still intact.
  assert.match(worker, /planM8QueueBatch/);
  assert.match(worker, /createBatch\(plan\.creates\)/);
  const consumer = fs.readFileSync(path.join(process.cwd(), "workers", "async-pipeline", "src", "ingest-stage-consumer.ts"), "utf8");
  assert.match(consumer, /planIngestStageBatch/);
  assert.match(consumer, /isIngestStageQueueMessage/);
});

test("planIngestStageBatch routes invalid/blocked/eligible and consume handles ack/retry/no-op", async () => {
  const db = createDatabases();
  const ingestDb = binding(db.ingest);
  const coreDb = binding(db.core);
  try {
    const openGate = resolveIngestStageRolloutGate(true, "production", "crawl");
    const { job } = await registerIngestStageJob(ingestDb, { stage: "crawl", articleId: "a1", sourceVersion: "v1", contentHash: "h1", now: NOW });
    const [claimed] = await claimIngestStageJobs(ingestDb, { stage: "crawl", workerId: "w1", limit: 1, leaseSeconds: 300, now: NOW });
    const message = buildIngestStageQueueMessage({ stage: "crawl", jobId: job.id, articleId: "a1", sourceVersion: "v1", contentHash: "h1", fencingToken: claimed.claimed_fencing_token as string, enqueuedAt: NOW });
    const forged = { ...message, idempotencyKey: "forged" };

    const closedGate = resolveIngestStageRolloutGate(false, "production", "crawl");
    const closed = planIngestStageBatch(closedGate, [{ body: message }, { body: forged }], (m) => m.body);
    assert.equal(closed.eligible.length, 0);
    assert.equal(closed.blocked.length, 1);
    assert.equal(closed.invalid.length, 1);

    const acked: string[] = [];
    const retried: Array<{ id: string; delay?: number }> = [];
    const batch = {
      queue: INGEST_STAGE_QUEUES.crawl,
      messages: [
        { id: "ok", body: message, ack: () => acked.push("ok"), retry: () => undefined },
        { id: "bad", body: forged, ack: () => undefined, retry: (o?: { delaySeconds?: number }) => retried.push({ id: "bad", delay: o?.delaySeconds }) },
      ],
    };
    const result = await consumeIngestStageBatch(batch, {
      gate: openGate, ingestDb, coreDb, now: NOW,
      handlers: {
        crawl: async () => ({ status: "succeeded", resultRef: "ref-1" }),
      },
      env: {},
      invalidRetryDelaySeconds: 300,
    });
    assert.equal(result.invalid, 1);
    assert.equal(result.processed, 1);
    assert.equal(result.completed, 1);
    assert.deepEqual(acked, ["ok"]);
    assert.deepEqual(retried, [{ id: "bad", delay: 300 }]);
    // Completion is durable and requires the exact lease token.
    const row = await getIngestStageJobById(ingestDb, job.id);
    assert.equal(row?.status, "succeeded");
  } finally {
    db.ingest.close(); db.core.close();
  }
});
