import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  buildIngestStageQueueMessage,
  INGEST_STAGE_QUEUES,
  type IngestStage,
  type IngestStageQueueMessage,
} from "../lib/cloudflare/ingest-stages/contracts";
import { resolveIngestStageRolloutGate } from "../lib/cloudflare/ingest-stages/flags";
import {
  claimIngestStageJobs,
  getIngestStageJobById,
  registerIngestStageJob,
} from "../lib/cloudflare/ingest-stages/repository";
import {
  listPendingIngestStageDispatch,
  registerIngestStageDispatchOutbox,
} from "../lib/cloudflare/ingest-stages/outbox";
import {
  dispatchIngestStagePass,
  reconcileIngestStageDispatch,
  type IngestStageQueueSender,
} from "../lib/cloudflare/ingest-stages/dispatcher";
import {
  consumeIngestStageBatch,
  type IngestStageHandlerRegistry,
  type IngestStageQueueMessageHandle,
} from "../workers/async-pipeline/src/ingest-stage-consumer";
import {
  createIngestStageHandlers,
  enqueueIngestStageDiscovery,
  type IngestStagePublicationAdapter,
  type IngestStageRawBucket,
  type IngestStageSearchAdapter,
  type IngestStageTranslationAdapter,
} from "../workers/async-pipeline/src/ingest-stage-handlers";
import type { NativeCrawlerBindings } from "../workers/async-pipeline/src/native-crawler";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";

const NOW = "2026-10-08T00:00:00.000Z";
const root = process.cwd();
const INGEST_SCHEMA = [
  "0001_init.sql",
  "0002_inventory_discovery_idempotency.sql",
  "0003_ingest_stage_jobs.sql",
].map((file) => fs.readFileSync(path.join(root, "d1", "worldcons_ingest", file), "utf8")).join("\n");
const CORE_SCHEMA = [
  "0001_init.sql",
  "0002_translation_pipeline.sql",
  "0003_ingest_core_bridge_ledger.sql",
].map((file) => fs.readFileSync(path.join(root, "d1", "worldcons_core", file), "utf8")).join("\n");

/** A SQLite-backed `D1RuntimeDatabase` with `run`, `all` and `batch`. */
function sqliteBinding(database: DatabaseSync): D1RuntimeDatabase {
  return {
    prepare(sql: string): D1RuntimePreparedStatement {
      let values: unknown[] = [];
      const prepared = {
        bind(...next: unknown[]) {
          values = next;
          return prepared;
        },
        async first<T = Record<string, unknown>>() {
          try {
            const rows = database.prepare(sql).all(...(values as SQLInputValue[])) as T[];
            return rows[0] ?? null;
          } catch {
            return null;
          }
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
        const out = [];
        for (const statement of statements) {
          if (!statement.run) throw new Error("test.batch_statement_not_runnable");
          const result = await statement.run();
          if (result.success === false || result.error) {
            throw new Error(result.error ?? "test.batch_statement_failed");
          }
          out.push(result);
        }
        database.exec("COMMIT");
        return out;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** In-memory R2 bucket compatible with both crawler and handler surfaces. */
function memoryBucket() {
  const store = new Map<string, Uint8Array>();
  const bucket: IngestStageRawBucket = {
    async put(key, value) { store.set(key, value); },
    async get(key) {
      const value = store.get(key);
      if (!value) return null;
      return { arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer };
    },
  };
  return { bucket, store };
}

function response(body: string, status = 200, contentType = "text/html") {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

const ROBOTS = "User-agent: *\nAllow: /\nCrawl-delay: 0";
const FRANCE_LISTING_URL = "https://www.conseil-constitutionnel.fr/les-decisions";
const FRANCE_DETAIL_PATH = "/decision/2026/2026912QPC.htm";
const FRANCE_DETAIL_URL = `https://www.conseil-constitutionnel.fr${FRANCE_DETAIL_PATH}`;

function franceFetch(): typeof fetch {
  const decisionText = "Official French constitutional decision text on constitutional rights and the governing principles. ".repeat(12);
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return response(ROBOTS);
    if (url === FRANCE_LISTING_URL) {
      return response(`<a href="${FRANCE_DETAIL_PATH}">Décision n° 2026-912 QPC du 28 septembre 2026</a>`);
    }
    if (url === FRANCE_DETAIL_URL) {
      return response(`<html><main><h1>Décision n° 2026-912 QPC</h1>${decisionText}</main></html>`);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

interface Harness {
  ingest: DatabaseSync;
  core: DatabaseSync;
  ingestDb: D1RuntimeDatabase;
  coreDb: D1RuntimeDatabase;
  crawlerBindings: NativeCrawlerBindings;
  rawBucket: IngestStageRawBucket;
  rawStore: Map<string, Uint8Array>;
  handlers: IngestStageHandlerRegistry;
  messageFor: (stage: IngestStage) => Promise<IngestStageQueueMessage[]>;
  consume: (messages: Array<{ id: string; body: IngestStageQueueMessage }>) => Promise<{
    result: Awaited<ReturnType<typeof consumeIngestStageBatch>>;
    acked: string[];
    retried: string[];
  }>;
}

interface HarnessDatabases {
  core: DatabaseSync;
  coreDb: D1RuntimeDatabase;
  ingest: DatabaseSync;
  ingestDb: D1RuntimeDatabase;
}

interface HarnessAdapters {
  translation?: (dbs: HarnessDatabases) => IngestStageTranslationAdapter;
  publication?: (dbs: HarnessDatabases) => IngestStagePublicationAdapter;
  search?: (dbs: HarnessDatabases) => IngestStageSearchAdapter;
  allowlist?: string;
}

interface FullHarness extends Harness {
  /** Consume messages for an arbitrary stage queue (records control). */
  consumeStage: (stage: IngestStage, messages: Array<{ id: string; body: IngestStageQueueMessage }>) => Promise<{
    result: Awaited<ReturnType<typeof consumeIngestStageBatch>>;
    acked: string[];
    retried: string[];
  }>;
}

function createFullHarness(adapters: HarnessAdapters = {}): FullHarness {
  const ingest = new DatabaseSync(":memory:");
  const core = new DatabaseSync(":memory:");
  ingest.exec(INGEST_SCHEMA);
  core.exec(CORE_SCHEMA);
  const ingestDb = sqliteBinding(ingest);
  const coreDb = sqliteBinding(core);
  const { bucket, store } = memoryBucket();
  const crawlerBindings = {
    WORLDCONS_CORE: coreDb,
    WORLDCONS_INGEST: ingestDb,
    WORLDCONS_RAW: { async put(key: string, value: Uint8Array) { store.set(key, value); } },
  } as unknown as NativeCrawlerBindings;
  const dbs: HarnessDatabases = { core, coreDb, ingest, ingestDb };
  const handlers = createIngestStageHandlers({
    crawlerBindings,
    rawBucket: bucket,
    fetch: franceFetch(),
    now: () => NOW,
    ...(adapters.translation ? { translation: adapters.translation(dbs) } : {}),
    ...(adapters.publication ? { publication: adapters.publication(dbs) } : {}),
    ...(adapters.search ? { search: adapters.search(dbs) } : {}),
  });
  const gate = resolveIngestStageRolloutGate(true, "production", adapters.allowlist ?? "discovery,crawl,normalize,translate,public-judgment,publish,search");
  const messageFor = async (stage: IngestStage) => {
    const sent: IngestStageQueueMessage[] = [];
    const queue: IngestStageQueueSender = { async send(body) { sent.push(body); return { ok: true }; } };
    await dispatchIngestStagePass({ ingestDb, queue, stage, workerId: `w:${stage}`, limit: 10, leaseSeconds: 300, now: NOW });
    return sent;
  };
  const consumeStage = async (stage: IngestStage, messages: Array<{ id: string; body: IngestStageQueueMessage }>) => {
    const acked: string[] = [];
    const retried: string[] = [];
    const wrapped: IngestStageQueueMessageHandle[] = messages.map((message) => ({
      body: message.body,
      ack: () => acked.push(message.id),
      retry: () => retried.push(message.id),
    }));
    const result = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES[stage], messages: wrapped }, {
      gate, ingestDb, coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
    });
    return { result, acked, retried };
  };
  return {
    ingest, core, ingestDb, coreDb, crawlerBindings, rawBucket: bucket, rawStore: store, handlers, messageFor,
    consume: (messages) => consumeStage("discovery", messages),
    consumeStage,
  };
}

function createHarness(): Harness {
  return createFullHarness({ allowlist: "discovery,crawl,normalize" });
}

test("A: discovery -> crawl -> normalize persists exactly one publishable article and stops at translate (fail closed)", async () => {
  const harness = createHarness();
  try {
    const seed = await enqueueIngestStageDiscovery(harness.ingestDb, harness.rawBucket, { sourceKey: "fr-conseil-constitutionnel", limit: 1, now: NOW });
    assert.equal(seed.created, true);

    const discoveryMessages = await harness.messageFor("discovery");
    assert.equal(discoveryMessages.length, 1);
    assert.equal(discoveryMessages[0].stage, "discovery");
    assert.ok(discoveryMessages[0].fencingToken.length > 0, "queue message carries a fencing token");

    const discoveryConsume = await harness.consume(discoveryMessages.map((body, index) => ({ id: `d${index}`, body })));
    assert.equal(discoveryConsume.result.completed, 1, JSON.stringify(discoveryConsume.result));
    assert.deepEqual(discoveryConsume.acked, ["d0"]);

    const crawlMessages = await harness.messageFor("crawl");
    assert.equal(crawlMessages.length, 1, "discovery fanned out exactly one crawl job");
    const crawlConsume = await harness.consume(crawlMessages.map((body, index) => ({ id: `c${index}`, body })));
    assert.equal(crawlConsume.result.completed, 1, JSON.stringify(crawlConsume.result));

    const normalizeMessages = await harness.messageFor("normalize");
    assert.equal(normalizeMessages.length, 1, "crawl advanced to exactly one normalize job");
    const normalizeConsume = await harness.consume(normalizeMessages.map((body, index) => ({ id: `n${index}`, body })));
    assert.equal(normalizeConsume.result.completed, 1, JSON.stringify(normalizeConsume.result));

    const articles = harness.core.prepare("SELECT status, translation_status, cleaned_text, source_metadata FROM articles").all() as Array<{ status: string; translation_status: string; cleaned_text: string; source_metadata: string }>;
    assert.equal(articles.length, 1);
    assert.equal(articles[0].status, "cleaned");
    assert.equal(articles[0].translation_status, "pending");
    const metadata = JSON.parse(articles[0].source_metadata) as { collection: { publishable: boolean; sourceTextAvailable: boolean } };
    assert.equal(metadata.collection.publishable, true);
    assert.equal(metadata.collection.sourceTextAvailable, true);

    // normalize -> translate has NO handler, so no translate job may exist.
    const jobs = harness.ingest.prepare("SELECT stage,status FROM ingest_stage_jobs ORDER BY stage").all() as Array<{ stage: string; status: string }>;
    assert.deepEqual([...new Set(jobs.map((job) => job.stage))].sort(), ["crawl", "discovery", "normalize"]);
    assert.ok(!jobs.some((job) => job.stage === "translate"), "no downstream job registered for an unwired stage");
    assert.ok(jobs.every((job) => job.status === "succeeded"), JSON.stringify(jobs));
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

test("B: duplicate delivery of a completed stage message is acked and creates no duplicate work", async () => {
  const harness = createHarness();
  try {
    await enqueueIngestStageDiscovery(harness.ingestDb, harness.rawBucket, { sourceKey: "fr-conseil-constitutionnel", limit: 1, now: NOW });
    const first = await harness.messageFor("discovery");
    const firstConsume = await harness.consume(first.map((body, i) => ({ id: `x${i}`, body })));
    assert.equal(firstConsume.result.completed, 1);

    // Redeliver the same (now terminal) job message.
    const replay = await harness.consume(first.map((body, i) => ({ id: `r${i}`, body })));
    assert.equal(replay.result.completed, 0);
    assert.deepEqual(replay.acked, ["r0"]);
    assert.equal(replay.result.ignored, 1);
    const crawlJobs = harness.ingest.prepare("SELECT id FROM ingest_stage_jobs WHERE stage='crawl'").all() as Array<{ id: string }>;
    assert.equal(crawlJobs.length, 1, "duplicate delivery must not fan out a second crawl job");
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

test("C: a live job with no registered handler is blocked (dead-lettered), never silently acked or completed", async () => {
  const harness = createHarness();
  try {
    const { job } = await registerIngestStageJob(harness.ingestDb, { stage: "translate", articleId: "a1", sourceVersion: "v1", contentHash: "h1", now: NOW });
    const [claimed] = await claimIngestStageJobs(harness.ingestDb, { stage: "translate", workerId: "w", limit: 1, leaseSeconds: 300, now: NOW });
    const message = buildIngestStageQueueMessage({
      stage: "translate", jobId: job.id, articleId: "a1", sourceVersion: "v1", contentHash: "h1",
      fencingToken: claimed.claimed_fencing_token as string, enqueuedAt: NOW,
    });
    const gate = resolveIngestStageRolloutGate(true, "production", "translate");
    const acked: string[] = [];
    const result = await consumeIngestStageBatch({
      queue: INGEST_STAGE_QUEUES.translate,
      messages: [{ body: message, ack: () => acked.push("a"), retry: () => undefined }],
    }, { gate, ingestDb: harness.ingestDb, coreDb: harness.coreDb, now: NOW, handlers: {}, env: {}, invalidRetryDelaySeconds: 300 });
    assert.equal(result.blockedJobs, 1);
    assert.deepEqual(acked, ["a"]);
    const row = await getIngestStageJobById(harness.ingestDb, job.id);
    assert.equal(row?.status, "dead_letter");
    assert.equal(row?.last_error_code, "ingest_stage.handler_missing");
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

test("D: an expired lease is reclaimed under a new fence; the stale message cannot complete or ack the live job", async () => {
  const harness = createHarness();
  try {
    const { job } = await registerIngestStageJob(harness.ingestDb, { stage: "crawl", articleId: "a1", sourceVersion: "v1", contentHash: "h1", now: NOW });
    // Claim with a 1-second lease, then let it expire.
    const [stale] = await claimIngestStageJobs(harness.ingestDb, { stage: "crawl", workerId: "old", limit: 1, leaseSeconds: 1, now: NOW });
    const staleMessage = buildIngestStageQueueMessage({
      stage: "crawl", jobId: job.id, articleId: "a1", sourceVersion: "v1", contentHash: "h1",
      fencingToken: stale.claimed_fencing_token as string, enqueuedAt: NOW,
    });
    const later = "2026-10-08T01:00:00.000Z";
    const [reclaimed] = await claimIngestStageJobs(harness.ingestDb, { stage: "crawl", workerId: "new", limit: 1, leaseSeconds: 300, now: later });
    assert.equal(reclaimed.claimed_fencing_token, "2");

    const gate = resolveIngestStageRolloutGate(true, "production", "crawl");
    const acked: string[] = [];
    const retried: string[] = [];
    const handlers: IngestStageHandlerRegistry = { crawl: async () => ({ status: "succeeded", resultRef: "should-not-run" }) };
    const staleResult = await consumeIngestStageBatch({
      queue: INGEST_STAGE_QUEUES.crawl,
      messages: [{ body: staleMessage, ack: () => acked.push("stale"), retry: () => retried.push("stale") }],
    }, { gate, ingestDb: harness.ingestDb, coreDb: harness.coreDb, now: later, handlers, env: {}, invalidRetryDelaySeconds: 300 });
    // The stale delivery is acked (a newer owner holds the lease) but performs no work.
    assert.equal(staleResult.completed, 0);
    assert.equal(staleResult.stale, 1);
    const afterStale = await getIngestStageJobById(harness.ingestDb, job.id);
    assert.equal(afterStale?.status, "leased");
    assert.equal(afterStale?.claimed_fencing_token, "2");

    // The current owner's message completes successfully.
    const liveMessage = buildIngestStageQueueMessage({
      stage: "crawl", jobId: job.id, articleId: "a1", sourceVersion: "v1", contentHash: "h1",
      fencingToken: reclaimed.claimed_fencing_token as string, enqueuedAt: later,
    });
    const liveResult = await consumeIngestStageBatch({
      queue: INGEST_STAGE_QUEUES.crawl,
      messages: [{ body: liveMessage, ack: () => acked.push("live"), retry: () => retried.push("live") }],
    }, { gate, ingestDb: harness.ingestDb, coreDb: harness.coreDb, now: later, handlers, env: {}, invalidRetryDelaySeconds: 300 });
    assert.equal(liveResult.completed, 1);
    const final = await getIngestStageJobById(harness.ingestDb, job.id);
    assert.equal(final?.status, "succeeded");
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

test("E: a live pending job delivered without a fence ack retries to a fresh dispatch rather than acking", async () => {
  const harness = createHarness();
  try {
    const { job } = await registerIngestStageJob(harness.ingestDb, { stage: "normalize", articleId: "a1", sourceVersion: "v1", contentHash: "h1", now: NOW });
    const gate = resolveIngestStageRolloutGate(true, "production", "normalize");
    const acked: string[] = [];
    const retried: string[] = [];
    // A message claiming a fence but the row is still pending (never leased).
    const message = buildIngestStageQueueMessage({
      stage: "normalize", jobId: job.id, articleId: "a1", sourceVersion: "v1", contentHash: "h1",
      fencingToken: "1", enqueuedAt: NOW,
    });
    const result = await consumeIngestStageBatch({
      queue: INGEST_STAGE_QUEUES.normalize,
      messages: [{ body: message, ack: () => acked.push("a"), retry: () => retried.push("r") }],
    }, { gate, ingestDb: harness.ingestDb, coreDb: harness.coreDb, now: NOW, handlers: { normalize: async () => ({ status: "succeeded" }) }, env: {}, invalidRetryDelaySeconds: 300 });
    assert.equal(result.stale, 1);
    assert.deepEqual(acked, []);
    assert.deepEqual(retried, ["r"]);
    const row = await getIngestStageJobById(harness.ingestDb, job.id);
    assert.equal(row?.status, "pending", "a live pending job must remain claimable, not be completed");
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

test("F: dispatcher never completes a job and re-arms an outbox row superseded by a newer fence", async () => {
  const harness = createHarness();
  try {
    const { sender, sent } = (() => {
      const sent: IngestStageQueueMessage[] = [];
      const sender: IngestStageQueueSender = { async send(body) { sent.push(body); return {}; } };
      return { sender, sent };
    })();
    const { job } = await registerIngestStageJob(harness.ingestDb, { stage: "crawl", articleId: "a1", sourceVersion: "v1", contentHash: "h1", now: NOW });
    const first = await dispatchIngestStagePass({ ingestDb: harness.ingestDb, queue: sender, stage: "crawl", workerId: "w1", limit: 1, leaseSeconds: 1, now: NOW });
    assert.equal(first.enqueued, 1);
    assert.equal(first.failed, 0);
    // The dispatcher leaves the job leased, not succeeded.
    const afterFirst = await getIngestStageJobById(harness.ingestDb, job.id);
    assert.equal(afterFirst?.status, "leased");
    assert.equal(sent[0].fencingToken, "1");

    // Let the lease expire; a new dispatch claims under fence 2 and must resend.
    const later = "2026-10-08T01:00:00.000Z";
    const second = await dispatchIngestStagePass({ ingestDb: harness.ingestDb, queue: sender, stage: "crawl", workerId: "w2", limit: 1, leaseSeconds: 300, now: later });
    assert.equal(second.enqueued, 1, "a superseded outbox row must be re-armed and re-sent");
    assert.equal(sent.length, 2);
    assert.equal(sent[1].fencingToken, "2");
    assert.equal((await listPendingIngestStageDispatch(harness.ingestDb, { limit: 10, now: later })).length, 0);
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

test("G: bounded dispatch-outbox reconciliation replays a pending entry to the correct queue", async () => {
  const harness = createHarness();
  try {
    const { job } = await registerIngestStageJob(harness.ingestDb, { stage: "search", articleId: "a1", sourceVersion: "v1", contentHash: "h1", now: NOW });
    await claimIngestStageJobs(harness.ingestDb, { stage: "search", workerId: "w", limit: 1, leaseSeconds: 300, now: NOW });
    const claimed = await getIngestStageJobById(harness.ingestDb, job.id);
    const message = buildIngestStageQueueMessage({
      stage: "search", jobId: job.id, articleId: "a1", sourceVersion: "v1", contentHash: "h1",
      fencingToken: claimed?.claimed_fencing_token ?? "1", enqueuedAt: NOW,
    });
    await registerIngestStageDispatchOutbox(harness.ingestDb, { jobId: job.id, queueName: INGEST_STAGE_QUEUES.search, message, now: NOW });
    const seen: IngestStage[] = [];
    const sent: IngestStageQueueMessage[] = [];
    const queueFor = (stage: IngestStage): IngestStageQueueSender => ({ async send(body) { seen.push(stage); sent.push(body); return {}; } });
    const result = await reconcileIngestStageDispatch({ ingestDb: harness.ingestDb, queueFor, limit: 10, now: NOW });
    assert.deepEqual(result, { scanned: 1, resent: 1, failed: 0 });
    assert.deepEqual(seen, ["search"]);
    assert.equal(sent[0].stage, "search");
    assert.equal((await listPendingIngestStageDispatch(harness.ingestDb, { limit: 10, now: NOW })).length, 0);
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

test("H: the discovery bootstrap producer only enqueues and does no network collection", async () => {
  const harness = createHarness();
  try {
    const seed = await enqueueIngestStageDiscovery(harness.ingestDb, harness.rawBucket, { sourceKey: "de-bverfg", limit: 20, now: NOW });
    assert.equal(seed.created, true);
    const replay = await enqueueIngestStageDiscovery(harness.ingestDb, harness.rawBucket, { sourceKey: "de-bverfg", limit: 20, now: "2026-10-08T02:00:00.000Z" });
    assert.equal(replay.created, false, "discovery request registration is idempotent");
    const nextDay = await enqueueIngestStageDiscovery(harness.ingestDb, harness.rawBucket, { sourceKey: "de-bverfg", limit: 20, now: "2026-10-09T02:00:00.000Z" });
    assert.equal(nextDay.created, true, "a new daily window must not be suppressed by yesterday's completed discovery");
    assert.notEqual(nextDay.jobId, seed.jobId);
    const jobs = harness.ingest.prepare("SELECT stage,source_version FROM ingest_stage_jobs ORDER BY source_version").all() as Array<{ stage: string; source_version: string }>;
    assert.deepEqual(jobs.map((job) => job.stage), ["discovery", "discovery"]);
    assert.notEqual(jobs[0].source_version, jobs[1].source_version);
    const articles = harness.core.prepare("SELECT COUNT(*) AS count FROM articles").get() as { count: number };
    assert.equal(Number(articles.count), 0, "bootstrap must not write articles");
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

test("H2: tomorrow's discovery revisits an existing URL without duplicating the same-day job", async () => {
  const harness = createHarness();
  try {
    await enqueueIngestStageDiscovery(harness.ingestDb, harness.rawBucket, {
      sourceKey: "fr-conseil-constitutionnel", limit: 1, now: NOW,
    });
    const first = await harness.messageFor("discovery");
    const dayOne = await harness.consume(first.map((body, i) => ({ id: "day1-" + i, body })));
    assert.equal(dayOne.result.completed, 1);
    assert.equal(harness.ingest.prepare("SELECT COUNT(*) AS n FROM ingest_stage_jobs WHERE stage='crawl'").get()?.n, 1);

    const tomorrow = "2026-10-09T02:00:00.000Z";
    const request = await enqueueIngestStageDiscovery(harness.ingestDb, harness.rawBucket, {
      sourceKey: "fr-conseil-constitutionnel", limit: 1, now: tomorrow,
    });
    assert.equal(request.created, true);
    const again = await enqueueIngestStageDiscovery(harness.ingestDb, harness.rawBucket, {
      sourceKey: "fr-conseil-constitutionnel", limit: 1, now: tomorrow,
    });
    assert.equal(again.created, false, "two bootstrap ticks in one day are idempotent");
    const sent: IngestStageQueueMessage[] = [];
    await dispatchIngestStagePass({
      ingestDb: harness.ingestDb,
      queue: { async send(body) { sent.push(body); } },
      stage: "discovery", workerId: "day2", limit: 10,
      leaseSeconds: 300, now: tomorrow,
    });
    assert.equal(sent.length, 1);
    const acked: string[] = [];
    const second = await consumeIngestStageBatch({
      queue: INGEST_STAGE_QUEUES.discovery,
      messages: [{ body: sent[0], ack: () => acked.push("day2"), retry: () => undefined }],
    }, {
      gate: resolveIngestStageRolloutGate(true, "production", "discovery"),
      ingestDb: harness.ingestDb, coreDb: harness.coreDb,
      now: tomorrow, handlers: harness.handlers, env: {}, invalidRetryDelaySeconds: 300,
    });
    assert.equal(second.completed, 1);
    assert.deepEqual(acked, ["day2"]);
    const crawls = harness.ingest.prepare("SELECT source_version FROM ingest_stage_jobs WHERE stage='crawl' ORDER BY source_version")
      .all() as Array<{ source_version: string }>;
    assert.equal(crawls.length, 2, "a new day creates a new bounded, targeted crawl even for the same official URL");
    assert.notEqual(crawls[0].source_version, crawls[1].source_version);
    assert.equal(harness.core.prepare("SELECT COUNT(*) AS n FROM articles").get()?.n, 0, "discovery itself never publishes");
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

test("I: consumer completes only under the exact lease and marks the job durably", async () => {
  const harness = createHarness();
  try {
    const { job } = await registerIngestStageJob(harness.ingestDb, { stage: "crawl", articleId: "a1", sourceVersion: "v1", contentHash: "h1", now: NOW });
    // Wrong fence: row leased under token 1, message claims token 9.
    await claimIngestStageJobs(harness.ingestDb, { stage: "crawl", workerId: "w", limit: 1, leaseSeconds: 300, now: NOW });
    const forged = buildIngestStageQueueMessage({
      stage: "crawl", jobId: job.id, articleId: "a1", sourceVersion: "v1", contentHash: "h1", fencingToken: "9", enqueuedAt: NOW,
    });
    const gate = resolveIngestStageRolloutGate(true, "production", "crawl");
    const acked: string[] = [];
    const result = await consumeIngestStageBatch({
      queue: INGEST_STAGE_QUEUES.crawl,
      messages: [{ body: forged, ack: () => acked.push("a"), retry: () => undefined }],
    }, { gate, ingestDb: harness.ingestDb, coreDb: harness.coreDb, now: NOW, handlers: { crawl: async () => ({ status: "succeeded" }) }, env: {}, invalidRetryDelaySeconds: 300 });
    assert.equal(result.completed, 0);
    assert.equal(result.stale, 1);
    const row = await getIngestStageJobById(harness.ingestDb, job.id);
    assert.equal(row?.status, "leased", "a mismatched fence cannot complete the job");
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

/** Advances discovery -> crawl -> normalize and returns the verified core article id. */
async function runToNormalize(harness: FullHarness): Promise<string> {
  await enqueueIngestStageDiscovery(harness.ingestDb, harness.rawBucket, { sourceKey: "fr-conseil-constitutionnel", limit: 1, now: NOW });
  const discovery = await harness.messageFor("discovery");
  const d = await harness.consumeStage("discovery", discovery.map((body, i) => ({ id: `d${i}`, body })));
  assert.equal(d.result.completed, 1, JSON.stringify(d.result));
  const crawl = await harness.messageFor("crawl");
  const c = await harness.consumeStage("crawl", crawl.map((body, i) => ({ id: `c${i}`, body })));
  assert.equal(c.result.completed, 1, JSON.stringify(c.result));
  const normalize = await harness.messageFor("normalize");
  const n = await harness.consumeStage("normalize", normalize.map((body, i) => ({ id: `n${i}`, body })));
  assert.equal(n.result.completed, 1, JSON.stringify(n.result));
  const translateJob = harness.ingest.prepare("SELECT article_id FROM ingest_stage_jobs WHERE stage='translate'").get() as { article_id: string } | undefined;
  assert.ok(translateJob, "normalize registered a translate job");
  assert.ok(!translateJob!.article_id.startsWith("native:"), "downstream job carries the real core article id, not a native candidate id");
  return translateJob!.article_id;
}

function summaryMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    collection: { publishable: true, sourceTextAvailable: true, sourceUrlVerified: true, strategy: "fetch" },
    ...overrides,
  };
}

/** A mock translation adapter that performs the durable effect the real service would. */
function fakeTranslation(dbs: HarnessDatabases, options: { status?: "summarized" | "failed"; retryable?: boolean; summaryJson?: string; koreanTitle?: string } = {}): IngestStageTranslationAdapter {
  return {
    async summarize(articleId: string) {
      const status = options.status ?? "summarized";
      if (status === "failed") {
        dbs.core.prepare("UPDATE articles SET translation_status='failed' WHERE id=?").run(articleId);
        return { status: "failed", retryable: options.retryable ?? false, errorCode: "llm.quota" };
      }
      const summary = options.summaryJson ?? JSON.stringify({ koreanTitle: "요약", summary: { coreSummary: ["핵심"] }, entities: [], tags: [], categories: [], aiMetadata: { provider: "gemini", model: "fake" } });
      dbs.core.prepare("UPDATE articles SET status='summarized',translation_status='translated',summary_json=?,korean_title=?,summarized_at=?,updated_at=? WHERE id=?")
        .run(summary, options.koreanTitle ?? "요약", NOW, NOW, articleId);
      return { status: "summarized" };
    },
  };
}

function fakePublication(dbs: HarnessDatabases): IngestStagePublicationAdapter {
  return {
    async publish(articleId: string) {
      const row = dbs.core.prepare("SELECT state FROM article_publications_p3 WHERE article_id=?").get(articleId) as { state: string } | undefined;
      if (row?.state === "published") return { published: false, skippedReason: "ineligible" };
      const exists = dbs.core.prepare("SELECT id FROM articles WHERE id=?").get(articleId);
      if (!exists) return { published: false, skippedReason: "not_found" };
      dbs.core.prepare("INSERT INTO article_publications_p3 (id,article_id,state,version_id,revision,decided_by_type,decided_by_id,reason,published_at,withdrawn_at,created_at,updated_at) VALUES (?,?,'published',?,?,?,?,?,?,?,?,?)")
        .run(`pub-${articleId}`, articleId, "version-1", "1", "compatibility", "ingest-stage-publish", "staged publish", NOW, null, NOW, NOW);
      return { published: true, state: "published", versionId: "version-1", publicationRevision: 1 };
    },
  };
}

function fakeSearch(dbs: HarnessDatabases): IngestStageSearchAdapter {
  return {
    async project(articleId: string) {
      const published = dbs.core.prepare("SELECT state FROM article_publications_p3 WHERE article_id=? AND state='published'").get(articleId);
      if (!published) return { projected: false, errorCode: "ingest_stage.search_not_published" };
      return { projected: true, documentCount: 1, ftsCount: 1 };
    },
  };
}

test("J: full chain discovery->crawl->normalize->translate->public-judgment->publish->search adopts the real core article id", async () => {
  const harness = createFullHarness({
    translation: (dbs) => fakeTranslation(dbs),
    publication: (dbs) => fakePublication(dbs),
    search: (dbs) => fakeSearch(dbs),
  });
  try {
    const articleId = await runToNormalize(harness);
    assert.ok(/^[0-9a-f-]{36}$/i.test(articleId), `core article id is a UUID, got ${articleId}`);

    const translate = await harness.messageFor("translate");
    assert.equal(translate.length, 1);
    assert.equal(translate[0].articleId, articleId, "translate message addresses the real core id");
    const t = await harness.consumeStage("translate", translate.map((body, i) => ({ id: `t${i}`, body })));
    assert.equal(t.result.completed, 1, JSON.stringify(t.result));

    const pj = await harness.messageFor("public-judgment");
    assert.equal(pj.length, 1);
    assert.equal(pj[0].articleId, articleId);
    const p = await harness.consumeStage("public-judgment", pj.map((body, i) => ({ id: `p${i}`, body })));
    assert.equal(p.result.completed, 1, JSON.stringify(p.result));

    const publish = await harness.messageFor("publish");
    assert.equal(publish[0].articleId, articleId);
    const pub = await harness.consumeStage("publish", publish.map((body, i) => ({ id: `q${i}`, body })));
    assert.equal(pub.result.completed, 1, JSON.stringify(pub.result));
    assert.equal(harness.core.prepare("SELECT state FROM article_publications_p3 WHERE article_id=?").get(articleId)?.state, "published");

    const search = await harness.messageFor("search");
    assert.equal(search[0].articleId, articleId);
    const s = await harness.consumeStage("search", search.map((body, i) => ({ id: `s${i}`, body })));
    assert.equal(s.result.completed, 1, JSON.stringify(s.result));

    const jobs = harness.ingest.prepare("SELECT stage,status FROM ingest_stage_jobs").all() as Array<{ stage: string; status: string }>;
    assert.deepEqual([...new Set(jobs.map((j) => j.stage))].sort(), ["crawl", "discovery", "normalize", "public-judgment", "publish", "search", "translate"]);
    assert.ok(jobs.every((j) => j.status === "succeeded"), JSON.stringify(jobs));
    // The normalize -> translate advance event records the identity resolution.
    const advanced = harness.ingest.prepare("SELECT safe_details FROM ingest_stage_job_events WHERE event_type='job_stage_advanced' AND safe_details LIKE '%resolvedArticleId%'").get() as { safe_details: string } | undefined;
    assert.ok(advanced, "identity resolution is recorded as provenance");
    assert.match(advanced!.safe_details, /native:/);
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

test("K: translate blocks and dead-letters when the durable summary effect is missing", async () => {
  const harness = createFullHarness({
    // A summary service that reports success but writes nothing.
    translation: () => ({ async summarize() { return { status: "summarized" }; } }),
    publication: (dbs) => fakePublication(dbs),
    search: (dbs) => fakeSearch(dbs),
  });
  try {
    const articleId = await runToNormalize(harness);
    const translate = await harness.messageFor("translate");
    const t = await harness.consumeStage("translate", translate.map((body, i) => ({ id: `t${i}`, body })));
    assert.equal(t.result.completed, 0);
    assert.equal(t.result.retried, 1, "a non-durable success retries rather than completing");
    const job = harness.ingest.prepare("SELECT status,last_error_code FROM ingest_stage_jobs WHERE stage='translate' AND article_id=?").get(articleId) as { status: string; last_error_code: string };
    assert.equal(job.status, "pending");
    assert.equal(job.last_error_code, "ingest_stage.translation_not_durable");
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

test("L: public-judgment blocks metadata_only / unverified-provenance articles (no false publish)", async () => {
  const harness = createFullHarness({
    translation: (dbs) => fakeTranslation(dbs),
    publication: (dbs) => fakePublication(dbs),
    search: (dbs) => fakeSearch(dbs),
  });
  try {
    const articleId = await runToNormalize(harness);
    const translate = await harness.messageFor("translate");
    const t = await harness.consumeStage("translate", translate.map((body, i) => ({ id: `t${i}`, body })));
    assert.equal(t.result.completed, 1, "translate reaches public-judgment");
    // Now simulate drift: provenance is no longer publishable.
    harness.core.prepare("UPDATE articles SET source_metadata=? WHERE id=?")
      .run(JSON.stringify({ collection: { publishable: false, sourceTextAvailable: false, sourceUrlVerified: false, strategy: "fetch" } }), articleId);
    const pj = await harness.messageFor("public-judgment");
    const p = await harness.consumeStage("public-judgment", pj.map((body, i) => ({ id: `p${i}`, body })));
    assert.equal(p.result.completed, 0);
    assert.equal(p.result.blockedJobs, 1);
    const job = harness.ingest.prepare("SELECT status,last_error_code FROM ingest_stage_jobs WHERE stage='public-judgment'").get() as { status: string; last_error_code: string };
    assert.equal(job.status, "dead_letter");
    assert.equal(job.last_error_code, "ingest_stage.public_judgment_not_publishable");
    assert.equal(harness.core.prepare("SELECT COUNT(*) n FROM article_publications_p3").get()?.n, 0);
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

test("M: public-judgment blocks an unverified Case Catalog anchor (hash mismatch)", async () => {
  const harness = createFullHarness({
    translation: (dbs) => fakeTranslation(dbs),
    publication: (dbs) => fakePublication(dbs),
    search: (dbs) => fakeSearch(dbs),
  });
  try {
    const articleId = await runToNormalize(harness);
    const translate = await harness.messageFor("translate");
    const t = await harness.consumeStage("translate", translate.map((body, i) => ({ id: `t${i}`, body })));
    assert.equal(t.result.completed, 1, "translate reaches public-judgment");
    // A published catalog head whose anchor source hash does not match the enrichment.
    harness.core.prepare("INSERT INTO article_content_versions_p3 (id,article_id,revision,content_hash,provenance_actor_type,slug,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,created_at,version_role,source_content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("anchor-1", articleId, "1", "anchor-hash", "import", "slug", "fr-conseil-constitutionnel", "France", "Conseil", "decision", "u", "u", "fr", NOW, "authoritative_source", "real-hash");
    harness.core.prepare("INSERT INTO case_catalog_publications_v1 (id,article_id,state,source_anchor_version_id,revision,source_policy_version,decided_by_type,reason,published_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("cat-1", articleId, "published", "anchor-1", "1", "v1", "system", "seed", NOW, NOW, NOW);
    harness.core.prepare("INSERT INTO article_content_versions_p3 (id,article_id,revision,content_hash,provenance_actor_type,slug,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,created_at,version_role,source_anchor_version_id,enrichment_source_content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("enrich-1", articleId, "2", "enrich-hash", "llm", "slug", "fr-conseil-constitutionnel", "France", "Conseil", "decision", "u", "u", "fr", NOW, "enrichment_full", "anchor-1", "different-hash");
    harness.core.prepare("INSERT INTO article_publications_p3 (id,article_id,state,version_id,revision,decided_by_type,reason,published_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("pub-enrich", articleId, "published", "enrich-1", "1", "compatibility", "x", NOW, NOW, NOW);
    const pj = await harness.messageFor("public-judgment");
    const p = await harness.consumeStage("public-judgment", pj.map((body, i) => ({ id: `p${i}`, body })));
    assert.equal(p.result.completed, 0);
    assert.equal(p.result.blockedJobs, 1);
    assert.equal(harness.ingest.prepare("SELECT last_error_code FROM ingest_stage_jobs WHERE stage='public-judgment'").get()?.last_error_code, "ingest_stage.public_judgment_anchor_unverified");
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

test("N: publish blocks an ineligible article instead of retrying into a false success", async () => {
  const harness = createFullHarness({
    translation: (dbs) => fakeTranslation(dbs),
    publication: (dbs) => fakePublication(dbs),
    search: (dbs) => fakeSearch(dbs),
  });
  try {
    const articleId = await runToNormalize(harness);
    // A publish job for a non-existent article id.
    await registerIngestStageJob(harness.ingestDb, { stage: "publish", articleId: "00000000-0000-4000-8000-000000000000", sourceVersion: "v", contentHash: "h", now: NOW });
    const publish = await harness.messageFor("publish");
    const target = publish.find((m) => m.articleId === "00000000-0000-4000-8000-000000000000");
    assert.ok(target);
    const pub = await harness.consumeStage("publish", [{ id: "q", body: target! }]);
    assert.equal(pub.result.completed, 0);
    assert.equal(pub.result.blockedJobs, 1);
    assert.equal(harness.core.prepare("SELECT COUNT(*) n FROM article_publications_p3").get()?.n, 0);
    void articleId;
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

test("O: per-article isolation - an unrelated pending translate job is never processed", async () => {
  const translateCalls: string[] = [];
  const harness = createFullHarness({
    translation: () => ({ async summarize(articleId) { translateCalls.push(articleId); return { status: "summarized" }; } }),
    publication: (dbs) => fakePublication(dbs),
    search: (dbs) => fakeSearch(dbs),
  });
  try {
    const addressed = "00000000-0000-4000-8000-0000000000aa";
    const unrelated = "00000000-0000-4000-8000-0000000000ab";
    await registerIngestStageJob(harness.ingestDb, { stage: "translate", articleId: addressed, sourceVersion: "v", contentHash: "h", now: NOW });
    await registerIngestStageJob(harness.ingestDb, { stage: "translate", articleId: unrelated, sourceVersion: "v", contentHash: "h", now: NOW });
    // Claim only the addressed job; the unrelated one stays pending (unclaimed).
    const claimed = await claimIngestStageJobs(harness.ingestDb, { stage: "translate", workerId: "w", limit: 1, leaseSeconds: 300, now: NOW });
    assert.equal(claimed.length, 1);
    const target = claimed[0];
    assert.equal(target.article_id, addressed);
    const message = buildIngestStageQueueMessage({
      stage: "translate", jobId: target.id, articleId: target.article_id, sourceVersion: "v", contentHash: "h",
      fencingToken: target.claimed_fencing_token as string, enqueuedAt: NOW,
    });
    await harness.consumeStage("translate", [{ id: "x", body: message }]);
    assert.deepEqual(translateCalls, [addressed], "only the addressed article is processed");
    const unrelatedRow = harness.ingest.prepare("SELECT status FROM ingest_stage_jobs WHERE article_id=?").get(unrelated) as { status: string };
    assert.equal(unrelatedRow.status, "pending", "the unrelated pending job is untouched");
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});

test("P: duplicate publish delivery is idempotent (one published row, one queue identity)", async () => {
  const harness = createFullHarness({
    translation: (dbs) => fakeTranslation(dbs),
    publication: (dbs) => fakePublication(dbs),
    search: (dbs) => fakeSearch(dbs),
  });
  try {
    const articleId = await runToNormalize(harness);
    harness.core.prepare("UPDATE articles SET status='summarized',translation_status='translated',summary_json=?,korean_title=?,source_metadata=? WHERE id=?")
      .run(JSON.stringify({ summary: {} }), "요약", JSON.stringify(summaryMetadata()), articleId);
    await registerIngestStageJob(harness.ingestDb, { stage: "publish", articleId, sourceVersion: "v", contentHash: "h", now: NOW });
    const claim = await claimIngestStageJobs(harness.ingestDb, { stage: "publish", workerId: "w", limit: 1, leaseSeconds: 300, now: NOW });
    const job = claim.find((j) => j.article_id === articleId)!;
    const message = buildIngestStageQueueMessage({ stage: "publish", jobId: job.id, articleId, sourceVersion: "v", contentHash: "h", fencingToken: job.claimed_fencing_token as string, enqueuedAt: NOW });
    const first = await harness.consumeStage("publish", [{ id: "a", body: message }]);
    assert.equal(first.result.completed, 1);
    // Redeliver the same terminal message.
    const second = await harness.consumeStage("publish", [{ id: "b", body: message }]);
    assert.equal(second.result.ignored, 1);
    assert.equal(harness.core.prepare("SELECT COUNT(*) n FROM article_publications_p3 WHERE article_id=? AND state='published'").get(articleId)?.n, 1);
  } finally {
    harness.ingest.close(); harness.core.close();
  }
});
