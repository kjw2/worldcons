import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  buildIngestStageIdempotencyKey,
  INGEST_STAGE_QUEUES,
  type IngestStageQueueMessage,
} from "../lib/cloudflare/ingest-stages/contracts";
import { resolveIngestStageRolloutGate } from "../lib/cloudflare/ingest-stages/flags";
import { getIngestStageJobById } from "../lib/cloudflare/ingest-stages/repository";
import {
  advanceCanaryCase,
  CANARY_PAYLOAD_PREFIX,
  canarySourceGateAllows,
  dispatchCanaryCase,
  planCanaryCase,
  seedCanaryCase,
  type CanaryRawBucket,
} from "../lib/cloudflare/ingest-stages/canary";
import { parseOperatorCanaryEvent } from "../lib/cloudflare/ingest-stages/canary-workflow-payload";
import {
  consumeIngestStageBatch,
  type IngestStageQueueMessageHandle,
} from "../workers/async-pipeline/src/ingest-stage-consumer";
import { createIngestStageHandlers } from "../workers/async-pipeline/src/ingest-stage-handlers";
import { operatorCanaryAuthorized } from "../workers/async-pipeline/src/worker-auth";
import {
  assertSelectOnly,
  evaluateManualApprovalPolicy,
  evaluateNativeCoreRelation,
  evaluateSevenStageLineage,
} from "../scripts/audit-worldcons-canary-lineage";
import type { NativeCrawlerBindings } from "../workers/async-pipeline/src/native-crawler";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";

const NOW = "2026-10-13T00:00:00.000Z";
const SEVEN = ["discovery", "crawl", "normalize", "translate", "public-judgment", "publish", "search"] as const;
const root = process.cwd();
const INGEST_SCHEMA = [
  "0001_init.sql",
  "0002_inventory_discovery_idempotency.sql",
  "0003_ingest_stage_jobs.sql",
  "0006_ingest_stage_canary.sql",
].map((file) => fs.readFileSync(path.join(root, "d1", "worldcons_ingest", file), "utf8")).join("\n");
const CORE_SCHEMA = [
  "0001_init.sql",
  "0002_translation_pipeline.sql",
  "0003_ingest_core_bridge_ledger.sql",
].map((file) => fs.readFileSync(path.join(root, "d1", "worldcons_core", file), "utf8")).join("\n");

const DE_URL = "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rk20260905_2bvr135824.html?nn=68112";
const DE_ECLI = "ECLI:DE:BVerfG:2026:rk20260905.2bvr135824";
const US_URL = "https://www.supremecourt.gov/opinions/25pdf/26a388_q86b.pdf";

function sqliteBinding(database: DatabaseSync): D1RuntimeDatabase {
  return {
    prepare(sql: string): D1RuntimePreparedStatement {
      let values: unknown[] = [];
      const prepared = {
        bind(...next: unknown[]) { values = next; return prepared; },
        async first<T = Record<string, unknown>>() {
          try { return (database.prepare(sql).all(...(values as SQLInputValue[])) as T[])[0] ?? null; } catch { return null; }
        },
        async all<T>() {
          try { return { success: true, results: database.prepare(sql).all(...(values as SQLInputValue[])) as T[] }; }
          catch (error) { return { success: false, results: [], error: error instanceof Error ? error.message : String(error) }; }
        },
        async run() {
          try {
            const result = database.prepare(sql).run(...(values as SQLInputValue[]));
            return { success: true, results: [], meta: { changes: Number(result.changes) } };
          } catch (error) { return { success: false, results: [], error: error instanceof Error ? error.message : String(error) }; }
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
          if (result.success === false || result.error) throw new Error(result.error ?? "test.batch_statement_failed");
          out.push(result);
        }
        database.exec("COMMIT");
        return out;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
}

/** In-memory R2 bucket for candidates + crawl artifacts. */
function memoryBucket() {
  const store = new Map<string, Uint8Array>();
  const bucket: CanaryRawBucket = {
    async put(key, value) { store.set(key, value); },
  };
  const reader = {
    async put(key: string, value: Uint8Array) { store.set(key, value); },
    async get(key: string) {
      const value = store.get(key);
      if (!value) return null;
      return { arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer };
    },
  };
  return { bucket, reader, store };
}

const ROBOTS = "User-agent: *\nAllow: /\nCrawl-delay: 0";

function deFetch(): typeof fetch {
  const body = `<html><main>${DE_ECLI}\n${"BVerfG official decision text. ".repeat(80)}</main></html>`;
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response(ROBOTS, { status: 200, headers: { "content-type": "text/plain" } });
    if (url.startsWith(DE_URL.split("?")[0])) return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    throw new Error(`unexpected fetch ${url}`);
  };
}

interface Harness {
  ingest: DatabaseSync;
  core: DatabaseSync;
  ingestDb: D1RuntimeDatabase;
  coreDb: D1RuntimeDatabase;
  bucket: CanaryRawBucket;
  reader: { put(key: string, value: Uint8Array): Promise<void>; get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> };
}

function createHarness(): Harness {
  const ingest = new DatabaseSync(":memory:");
  const core = new DatabaseSync(":memory:");
  ingest.exec(INGEST_SCHEMA);
  core.exec(CORE_SCHEMA);
  const ingestDb = sqliteBinding(ingest);
  const coreDb = sqliteBinding(core);
  const { bucket, reader } = memoryBucket();
  return { ingest, core, ingestDb, coreDb, bucket, reader };
}

function canaryHandlers(harness: Harness) {
  const rawBucket = {
    async put(key: string, value: Uint8Array) { await harness.reader.put(key, value); },
    async get(key: string) { return harness.reader.get(key); },
  };
  const crawlerBindings = {
    WORLDCONS_CORE: harness.coreDb,
    WORLDCONS_INGEST: harness.ingestDb,
    WORLDCONS_RAW: { async put(key: string, value: Uint8Array) { await harness.reader.put(key, value); } },
  } as unknown as NativeCrawlerBindings;
  return createIngestStageHandlers({
    crawlerBindings,
    rawBucket,
    fetch: deFetch(),
    now: () => NOW,
    canarySources: ["de-bverfg", "us-scotus"],
  });
}

test("canary plan: official host, identity and source are fail-closed", async () => {
  const good = await planCanaryCase({ sourceKey: "de-bverfg", candidateUrl: DE_URL, identifiers: { ecli: DE_ECLI } }, { now: NOW });
  assert.equal(good.accepted, true, JSON.stringify(good));
  assert.equal(good.candidate?.metadata.discoveryIndex, "operator-canary");
  assert.equal((good.candidate?.metadata.collection as { sourceUrlVerified: boolean }).sourceUrlVerified, false);
  assert.equal(good.payloadRef.startsWith(CANARY_PAYLOAD_PREFIX), true);
  assert.equal((good.candidate?.metadata.collection as { publishable: boolean }).publishable, false);
  assert.equal(good.candidate?.metadata.review, undefined, "a canary candidate must not self-mark review-required (no false publish)");

  const wrongEcli = await planCanaryCase({ sourceKey: "de-bverfg", candidateUrl: DE_URL, identifiers: { ecli: "ECLI:DE:BVerfG:2026:rk20260905.2bvr999999" } }, { now: NOW });
  assert.deepEqual([wrongEcli.accepted, wrongEcli.outcome], [false, "denied_identity"]);
  const noEcli = await planCanaryCase({ sourceKey: "de-bverfg", candidateUrl: DE_URL, identifiers: {} }, { now: NOW });
  assert.equal(noEcli.outcome, "denied_identity");
  const nonOfficial = await planCanaryCase({ sourceKey: "de-bverfg", candidateUrl: "https://example.com/x.html", identifiers: { ecli: DE_ECLI } }, { now: NOW });
  assert.equal(nonOfficial.outcome, "denied_official_host");
  const notCanary = await planCanaryCase({ sourceKey: "fr-conseil-constitutionnel", candidateUrl: DE_URL, identifiers: { ecli: DE_ECLI } }, { now: NOW });
  assert.equal(notCanary.outcome, "denied_source");
  const usNoDocket = await planCanaryCase({ sourceKey: "us-scotus", candidateUrl: US_URL, identifiers: {} }, { now: NOW });
  assert.equal(usNoDocket.outcome, "denied_identity");
  const usGood = await planCanaryCase({ sourceKey: "us-scotus", candidateUrl: US_URL, identifiers: { docket: "26A388" } }, { now: NOW });
  assert.equal(usGood.accepted, true);
  assert.equal(usGood.candidate?.metadata.docket, "26A388");
});

test("canary seed: deterministic id, immutable audit, and per-source rate limit", async () => {
  const h = createHarness();
  try {
    const plan = await planCanaryCase({ sourceKey: "de-bverfg", candidateUrl: DE_URL, identifiers: { ecli: DE_ECLI } }, { now: NOW });
    const first = await seedCanaryCase(h.ingestDb, h.bucket, plan, { operatorId: "op-1", deploymentRef: "test", now: NOW });
    assert.equal(first.outcome, "seeded");
    assert.equal(first.created, true);
    assert.ok(first.jobId);
    const stored = h.ingest.prepare("SELECT stage,source_key,article_id,payload_ref,status FROM ingest_stage_jobs").all() as Array<Record<string, unknown>>;
    assert.equal(stored.length, 1);
    assert.deepEqual({ ...stored[0] }, { stage: "crawl", source_key: "de-bverfg", article_id: first.candidateId, payload_ref: plan.payloadRef, status: "pending" });
    const audit = h.ingest.prepare("SELECT outcome,operator_id,identity_ecli FROM ingest_stage_canary_records_v1").all() as Array<Record<string, unknown>>;
    assert.deepEqual({ ...audit[0] }, { outcome: "seeded", operator_id: "op-1", identity_ecli: DE_ECLI });

    // Same case again: idempotent job, but the rate limit denies a *second* seed.
    const replay = await seedCanaryCase(h.ingestDb, h.bucket, plan, { operatorId: "op-1", deploymentRef: "test", now: NOW });
    assert.equal(replay.outcome, "denied_rate_limited");
    assert.equal(h.ingest.prepare("SELECT COUNT(*) n FROM ingest_stage_jobs").get()?.n, 1, "no duplicate job");
  } finally { h.ingest.close(); h.core.close(); }
});

test("canary dispatch leases only the named job under the explicit canary owner", async () => {
  const h = createHarness();
  try {
    const plan = await planCanaryCase({ sourceKey: "de-bverfg", candidateUrl: DE_URL, identifiers: { ecli: DE_ECLI } }, { now: NOW });
    const seed = await seedCanaryCase(h.ingestDb, h.bucket, plan, { operatorId: "op-1", deploymentRef: "test", now: NOW });
    const sent: IngestStageQueueMessage[] = [];
    const result = await dispatchCanaryCase({
      ingestDb: h.ingestDb,
      queue: { async send(body) { sent.push(body); return {}; } },
      jobId: seed.jobId!,
      canaryId: seed.canaryId,
      operatorId: "op-1",
      deploymentRef: "test",
      stage: "crawl",
      now: NOW,
    });
    assert.equal(result.dispatched, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].jobId, seed.jobId);
    const row = await getIngestStageJobById(h.ingestDb, seed.jobId!);
    assert.equal(row?.claimed_by, `canary-owner:${seed.canaryId}`);
    assert.equal(row?.status, "leased");
  } finally { h.ingest.close(); h.core.close(); }
});

test("canary crawl completes only when the official body identity matches, then stops before public judgment", async () => {
  const h = createHarness();
  try {
    const plan = await planCanaryCase({ sourceKey: "de-bverfg", candidateUrl: DE_URL, identifiers: { ecli: DE_ECLI } }, { now: NOW });
    const seed = await seedCanaryCase(h.ingestDb, h.bucket, plan, { operatorId: "op-1", deploymentRef: "test", now: NOW });
    const handlers = canaryHandlers(h);
    const gate = resolveIngestStageRolloutGate(true, "production", "discovery,crawl,normalize,translate,public-judgment,publish,search");
    const stagedSources = ["fr-conseil-constitutionnel", "es-tribunal-constitucional"];

    const sent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({
      ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } },
      jobId: seed.jobId!, canaryId: seed.canaryId, operatorId: "op-1",
      deploymentRef: "test", stage: "crawl", now: NOW,
    });

    // The source gate allows the explicit canary payload even though de-bverfg is not staged.
    const wrapped: IngestStageQueueMessageHandle[] = [{ body: sent[0], ack: () => undefined, retry: () => undefined }];
    const result = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.crawl, messages: wrapped }, {
      gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
      sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources }),
    });
    assert.equal(result.completed, 1, JSON.stringify(result));
    const crawlJob = await getIngestStageJobById(h.ingestDb, seed.jobId!);
    assert.equal(crawlJob?.status, "succeeded");

    // The crawl stage registers a normalize job carrying the crawl artifact.
    const normalizeJob = h.ingest.prepare("SELECT id,payload_ref FROM ingest_stage_jobs WHERE stage='normalize'").get() as { id: string; payload_ref: string } | undefined;
    assert.ok(normalizeJob, "crawl advanced to a normalize job");
    assert.ok(normalizeJob!.payload_ref.startsWith("stages/ingest-crawl/"), "the crawl artifact is handed to normalize");
    const nsent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({
      ingestDb: h.ingestDb, queue: { async send(body) { nsent.push(body); return {}; } },
      jobId: normalizeJob!.id, canaryId: seed.canaryId, operatorId: "op-1",
      deploymentRef: "test", stage: "normalize", now: NOW,
    });
    const nresult = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.normalize, messages: [{ body: nsent[0], ack: () => undefined, retry: () => undefined }] }, {
      gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
      sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources }),
    });
    assert.equal(nresult.completed, 1, JSON.stringify(nresult));

    const articles = h.core.prepare("SELECT status,source_metadata,cleaned_text FROM articles").all() as Array<{ status: string; source_metadata: string; cleaned_text: string }>;
    assert.equal(articles.length, 1, "the canary persisted exactly one article");
    assert.equal(articles[0].status, "cleaned");
    const metadata = JSON.parse(articles[0].source_metadata) as { collection: { sourceUrlVerified: boolean; publishable: boolean }; ecli: string };
    assert.equal(metadata.ecli, DE_ECLI, "official in-body ECLI was verified and persisted");
    assert.equal(metadata.collection.sourceUrlVerified, true);
    assert.equal(h.core.prepare("SELECT COUNT(*) n FROM article_publications_p3").get()?.n, 0, "the canary never publishes");
  } finally { h.ingest.close(); h.core.close(); }
});

test("bounded advance: only a fenced canary-owned succeeded job advances to a canary next stage", async () => {
  const h = createHarness();
  try {
    const plan = await planCanaryCase({ sourceKey: "de-bverfg", candidateUrl: DE_URL, identifiers: { ecli: DE_ECLI } }, { now: NOW });
    const seed = await seedCanaryCase(h.ingestDb, h.bucket, plan, { operatorId: "op-1", deploymentRef: "test", now: NOW });
    const handlers = canaryHandlers(h);
    const gate = resolveIngestStageRolloutGate(true, "production", "discovery,crawl,normalize,translate,public-judgment,publish,search");
    const stagedSources = ["fr-conseil-constitutionnel", "es-tribunal-constitucional"];

    // Advance before the crawl job has succeeded: declined.
    const tooEarly = await advanceCanaryCase({ ingestDb: h.ingestDb, jobId: seed.jobId!, canaryId: seed.canaryId, operatorId: "op-1", deploymentRef: "test", now: NOW });
    assert.equal(tooEarly.advanced, false);
    assert.equal(tooEarly.reason, "canary.advance_source_not_succeeded");

    // Run the crawl to succeeded (which registers the normalize job + advance event).
    const sent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } }, jobId: seed.jobId!, canaryId: seed.canaryId, operatorId: "op-1", deploymentRef: "test", stage: "crawl", now: NOW });
    const crawled = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.crawl, messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
      gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
      sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources }),
    });
    assert.equal(crawled.completed, 1, JSON.stringify(crawled));

    // Wrong canary id: the owner fence does not match. Declined.
    const wrongOwner = await advanceCanaryCase({ ingestDb: h.ingestDb, jobId: seed.jobId!, canaryId: "not-mine", operatorId: "op-1", deploymentRef: "test", now: NOW });
    assert.equal(wrongOwner.advanced, false);
    assert.equal(wrongOwner.reason, "canary.advance_owner_mismatch");

    // Correct provenance, no queue: resolves the next stage without dispatching.
    const resolvedOnly = await advanceCanaryCase({ ingestDb: h.ingestDb, jobId: seed.jobId!, canaryId: seed.canaryId, operatorId: "op-1", deploymentRef: "test", now: NOW });
    assert.equal(resolvedOnly.advanced, true, JSON.stringify(resolvedOnly));
    assert.equal(resolvedOnly.fromStage, "crawl");
    assert.equal(resolvedOnly.nextStage, "normalize");
    assert.equal(resolvedOnly.dispatched, false);
    assert.equal(resolvedOnly.enqueued, 0);
    const nextJob = await getIngestStageJobById(h.ingestDb, resolvedOnly.nextJobId!);
    assert.equal(nextJob?.stage, "normalize");
    assert.equal(nextJob?.source_key, "de-bverfg");
    assert.equal(nextJob?.status, "pending", "a resolve-only advance never leases the next job");
    // Resolve-only writes NO advance-dispatch audit row (no send happened).
    assert.equal(h.ingest.prepare("SELECT COUNT(*) n FROM ingest_stage_canary_records_v1 WHERE detail LIKE 'canary-advance-dispatch:%'").get()?.n, 0);
    // The advance never completes/publishes.
    assert.equal(h.core.prepare("SELECT COUNT(*) n FROM article_publications_p3").get()?.n, 0);
  } finally { h.ingest.close(); h.core.close(); }
});

test("bounded advance dispatch: enqueues exactly the next stage job to its own queue and audits only after the send", async () => {
  const h = createHarness();
  try {
    const plan = await planCanaryCase({ sourceKey: "de-bverfg", candidateUrl: DE_URL, identifiers: { ecli: DE_ECLI } }, { now: NOW });
    const seed = await seedCanaryCase(h.ingestDb, h.bucket, plan, { operatorId: "op-1", deploymentRef: "test", now: NOW });
    const handlers = canaryHandlers(h);
    const gate = resolveIngestStageRolloutGate(true, "production", "discovery,crawl,normalize,translate,public-judgment,publish,search");
    const stagedSources = ["fr-conseil-constitutionnel", "es-tribunal-constitucional"];
    const crawlSent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { crawlSent.push(body); return {}; } }, jobId: seed.jobId!, canaryId: seed.canaryId, operatorId: "op-1", deploymentRef: "test", stage: "crawl", now: NOW });
    await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.crawl, messages: [{ body: crawlSent[0], ack: () => undefined, retry: () => undefined }] }, {
      gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
      sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources }),
    });

    const stagesSent: Array<{ stage: string; body: IngestStageQueueMessage }> = [];
    const advanced = await advanceCanaryCase({
      ingestDb: h.ingestDb, jobId: seed.jobId!, canaryId: seed.canaryId, operatorId: "op-1", deploymentRef: "test", now: NOW,
      queueFor: (stage) => ({ async send(body) { stagesSent.push({ stage, body }); return {}; } }),
    });
    assert.equal(advanced.advanced, true, JSON.stringify(advanced));
    assert.equal(advanced.dispatched, true);
    assert.equal(advanced.enqueued, 1);
    assert.equal(advanced.reason, "canary.advance_dispatched");
    assert.equal(stagesSent.length, 1);
    assert.equal(stagesSent[0].stage, "normalize", "dispatched to the NEXT stage's own queue");
    assert.equal(stagesSent[0].body.jobId, advanced.nextJobId);
    // The row is leased under the canary owner fence.
    const nextRow = await getIngestStageJobById(h.ingestDb, advanced.nextJobId!);
    assert.equal(nextRow?.status, "leased");
    assert.equal(nextRow?.claimed_by, `canary-owner:${seed.canaryId}`);
    // Exactly one dispatched audit row, with the real canary source (not empty).
    const audit = h.ingest.prepare("SELECT source_key, outcome, detail FROM ingest_stage_canary_records_v1 WHERE outcome='dispatched' AND detail LIKE 'canary-advance-dispatch:%'").all() as Array<Record<string, unknown>>;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].source_key, "de-bverfg");
    assert.match(String(audit[0].detail), /canary-advance-dispatch:crawl->normalize/);
  } finally { h.ingest.close(); h.core.close(); }
});

test("bounded advance denials: non-canary origin, unresolved nextKey, forged stage, terminal and unknown job", async () => {
  const h = createHarness();
  try {
    // Unknown job id.
    const missing = await advanceCanaryCase({ ingestDb: h.ingestDb, jobId: "00000000-0000-4000-8000-000000000000", canaryId: "a".repeat(32), operatorId: "op", deploymentRef: null, now: NOW });
    assert.equal(missing.reason, "canary.advance_job_not_found");

    // A succeeded job owned by the canary but for a NON-canary source is refused.
    h.ingest.prepare("INSERT INTO ingest_stage_jobs (id,idempotency_key,stage,article_id,source_key,source_version,content_hash,status,priority,attempt_count,max_attempts,claimed_by,result_ref,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("noncanary-src", buildIngestStageIdempotencyKey({ articleId: "a", stage: "crawl", sourceVersion: "v", contentHash: "h" }), "crawl", "a", "fr-conseil-constitutionnel", "v", "h", "succeeded", 0, 1, 8, `canary-owner:${"b".repeat(32)}`, null, NOW, NOW, NOW);
    const nonCanary = await advanceCanaryCase({ ingestDb: h.ingestDb, jobId: "noncanary-src", canaryId: "b".repeat(32), operatorId: "op", deploymentRef: null, now: NOW });
    assert.equal(nonCanary.reason, "canary.advance_origin_not_canary");
    assert.equal(nonCanary.advanced, false);

    // A succeeded canary-owned job with NO advance event (no registered next job).
    h.ingest.prepare("INSERT INTO ingest_stage_jobs (id,idempotency_key,stage,article_id,source_key,source_version,content_hash,status,priority,attempt_count,max_attempts,claimed_by,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("no-event", buildIngestStageIdempotencyKey({ articleId: "b", stage: "crawl", sourceVersion: "v", contentHash: "h2" }), "crawl", "b", "de-bverfg", "v", "h2", "succeeded", 0, 1, 8, `canary-owner:${"c".repeat(32)}`, NOW, NOW, NOW);
    const noEvent = await advanceCanaryCase({ ingestDb: h.ingestDb, jobId: "no-event", canaryId: "c".repeat(32), operatorId: "op", deploymentRef: null, now: NOW });
    assert.equal(noEvent.reason, "canary.advance_next_event_missing");

    // An advance event whose nextKey resolves to a job of the WRONG stage is refused.
    h.ingest.prepare("INSERT INTO ingest_stage_jobs (id,idempotency_key,stage,article_id,source_key,source_version,content_hash,status,priority,attempt_count,max_attempts,claimed_by,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("mismatch-src", buildIngestStageIdempotencyKey({ articleId: "c", stage: "crawl", sourceVersion: "v", contentHash: "h3" }), "crawl", "c", "us-scotus", "v", "h3", "succeeded", 0, 1, 8, `canary-owner:${"d".repeat(32)}`, NOW, NOW, NOW);
    const wrongKey = buildIngestStageIdempotencyKey({ articleId: "c", stage: "translate", sourceVersion: "v", contentHash: "h3" });
    h.ingest.prepare("INSERT INTO ingest_stage_jobs (id,idempotency_key,stage,article_id,source_key,source_version,content_hash,status,priority,attempt_count,max_attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("wrongstage-next", wrongKey, "translate", "c", "us-scotus", "v", "h3", "pending", 0, 0, 8, NOW, NOW);
    h.ingest.prepare("INSERT INTO ingest_stage_job_events (id,job_id,attempt_id,event_type,stage,fencing_token,safe_details,occurred_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("ev-1", "mismatch-src", null, "job_stage_advanced", "crawl", "1", JSON.stringify({ nextStage: "translate", nextKey: wrongKey }), NOW);
    const stageMismatch = await advanceCanaryCase({ ingestDb: h.ingestDb, jobId: "mismatch-src", canaryId: "d".repeat(32), operatorId: "op", deploymentRef: null, now: NOW });
    assert.equal(stageMismatch.reason, "canary.advance_next_stage_mismatch");

    // A terminal 'search' job has no next stage.
    h.ingest.prepare("INSERT INTO ingest_stage_jobs (id,idempotency_key,stage,article_id,source_key,source_version,content_hash,status,priority,attempt_count,max_attempts,claimed_by,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("terminal-src", buildIngestStageIdempotencyKey({ articleId: "d", stage: "search", sourceVersion: "v", contentHash: "h4" }), "search", "d", "de-bverfg", "v", "h4", "succeeded", 0, 1, 8, `canary-owner:${"e".repeat(32)}`, NOW, NOW, NOW);
    const terminal = await advanceCanaryCase({ ingestDb: h.ingestDb, jobId: "terminal-src", canaryId: "e".repeat(32), operatorId: "op", deploymentRef: null, now: NOW });
    assert.equal(terminal.reason, "canary.advance_terminal_stage");

    // Every denial is retained in the audit ledger (never a silent no-op).
    const denials = h.ingest.prepare("SELECT COUNT(*) n FROM ingest_stage_canary_records_v1 WHERE outcome LIKE 'denied_%'").get() as { n: number };
    assert.ok(Number(denials.n) >= 5, `expected retained denial audits, got ${denials.n}`);
  } finally { h.ingest.close(); h.core.close(); }
});

test("canary source gate blocks a non-staged source without the explicit canary prefix at fetch stages", () => {
  const staged = ["fr-conseil-constitutionnel", "es-tribunal-constitucional"];
  // Staged source: always allowed.
  assert.equal(canarySourceGateAllows({ stage: "crawl", sourceKey: "fr-conseil-constitutionnel", payloadRef: null, stagedSources: staged }), true);
  // Non-staged source with a canary payload: allowed (controlled exception).
  assert.equal(canarySourceGateAllows({ stage: "crawl", sourceKey: "de-bverfg", payloadRef: `${CANARY_PAYLOAD_PREFIX}de-bverfg/x.json`, stagedSources: staged }), true);
  // Non-staged source WITHOUT the canary prefix: blocked.
  assert.equal(canarySourceGateAllows({ stage: "crawl", sourceKey: "de-bverfg", payloadRef: "stages/ingest-discovery/de-bverfg/x.json", stagedSources: staged }), false);
  assert.equal(canarySourceGateAllows({ stage: "discovery", sourceKey: "us-scotus", payloadRef: null, stagedSources: staged }), false);
  // Downstream stages are not the official-fetch entry and stay allowed.
  assert.equal(canarySourceGateAllows({ stage: "normalize", sourceKey: "de-bverfg", payloadRef: null, stagedSources: staged }), true);
});

test("canary source gate dead-letters a forged non-staged discovery job before any handler runs", async () => {
  const h = createHarness();
  try {
    // A discovery job for a non-staged, non-canary source (as an accidental
    // widening or a forged message would produce): correct identity key but a
    // plain (non-canary) payload ref.
    h.ingest.prepare("INSERT INTO ingest_stage_jobs (id,idempotency_key,stage,article_id,source_key,source_version,content_hash,status,priority,attempt_count,max_attempts,payload_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("d-forged", buildIngestStageIdempotencyKey({ articleId: "native:x", stage: "discovery", sourceVersion: "v", contentHash: "h" }), "discovery", "native:x", "de-bverfg", "v", "h", "pending", 0, 0, 8, "stages/ingest-discovery/de-bverfg/x.json", NOW, NOW);
    const sent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({
      ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } },
      jobId: "d-forged", canaryId: "x", operatorId: "op-1", deploymentRef: "test", stage: "discovery", now: NOW,
    });
    const gate = resolveIngestStageRolloutGate(true, "production", "discovery");
    let handlerRan = false;
    const result = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.discovery, messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
      gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, env: {}, invalidRetryDelaySeconds: 300,
      handlers: { discovery: async () => { handlerRan = true; return { status: "succeeded" }; } },
      sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: ["fr-conseil-constitutionnel", "es-tribunal-constitucional"] }),
    });
    assert.equal(handlerRan, false, "the handler must never run for a non-authorized source");
    assert.equal(result.blockedJobs, 1);
    const blocked = await getIngestStageJobById(h.ingestDb, "d-forged");
    assert.equal(blocked?.status, "dead_letter");
    assert.equal(blocked?.last_error_code, "ingest_stage.source_not_authorized");
  } finally { h.ingest.close(); h.core.close(); }
});

test("canary source gate allows the same de-bverfg job once it carries the explicit canary prefix", async () => {
  const h = createHarness();
  try {
    // Same job shape, but with the explicit canary payload ref: the gate allows
    // it, proving the exception is keyed on the canary identity, not the source.
    h.ingest.prepare("INSERT INTO ingest_stage_jobs (id,idempotency_key,stage,article_id,source_key,source_version,content_hash,status,priority,attempt_count,max_attempts,payload_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("d-ok", buildIngestStageIdempotencyKey({ articleId: "native:x", stage: "discovery", sourceVersion: "v", contentHash: "h" }), "discovery", "native:x", "de-bverfg", "v", "h", "pending", 0, 0, 8, `${CANARY_PAYLOAD_PREFIX}de-bverfg/x.json`, NOW, NOW);
    const sent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({
      ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } },
      jobId: "d-ok", canaryId: "x", operatorId: "op-1", deploymentRef: "test", stage: "discovery", now: NOW,
    });
    let ran = 0;
    const result = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.discovery, messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
      gate: resolveIngestStageRolloutGate(true, "production", "discovery"),
      ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, env: {}, invalidRetryDelaySeconds: 300,
      handlers: { discovery: async () => { ran += 1; return { status: "succeeded", registerNext: false }; } },
      sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: ["fr-conseil-constitutionnel", "es-tribunal-constitucional"] }),
    });
    assert.equal(ran, 1, "the canary-prefixed job is allowed through the source gate");
    assert.equal(result.completed, 1);
  } finally { h.ingest.close(); h.core.close(); }
});

test("canary never fabricates US 7/7: a US article without a manual authorization blocks at public judgment", async () => {
  const h = createHarness();
  try {
    // Simulate the durable US effect: an article that passed crawl with
    // publishable=false / review required (US policy holds manual review).
    h.core.prepare("INSERT INTO articles (id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,status,slug,cleaned_text,summary_json,korean_title,translation_status,source_metadata,content_hash,review_state,discovered_at,fetched_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("us-article-1", "us-scotus", "United States", "Supreme Court of the United States", "opinion", US_URL, US_URL, "en", "t", "summarized", "us-1",
        "opinion text ".repeat(200), JSON.stringify({ summary: { coreSummary: ["요약"] } }), "요약", "translated",
        JSON.stringify({ officialPdf: { r2Key: "artifacts/scotus_pdf/x.pdf", sha256: "a".repeat(64), docketVerified: true }, collection: { publishable: false, sourceTextAvailable: true, sourceUrlVerified: true, strategy: "official-pdf" }, review: { required: true } }),
        "h", "unreviewed", NOW, NOW, NOW, NOW);
    const handlers = canaryHandlers(h);
    const gate = resolveIngestStageRolloutGate(true, "production", "public-judgment");
    h.ingest.prepare("INSERT INTO ingest_stage_jobs (id,idempotency_key,stage,article_id,source_key,source_version,content_hash,status,priority,attempt_count,max_attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("pj-1", buildIngestStageIdempotencyKey({ articleId: "us-article-1", stage: "public-judgment", sourceVersion: "v", contentHash: "h" }), "public-judgment", "us-article-1", "us-scotus", "v", "h", "pending", 0, 0, 8, NOW, NOW);
    const sent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({
      ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } },
      jobId: "pj-1", canaryId: "us", operatorId: "op", deploymentRef: "test", stage: "public-judgment", now: NOW,
    });
    const result = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES["public-judgment"], messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
      gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
      sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: [] }),
    });
    assert.equal(result.completed, 0);
    assert.equal(result.blockedJobs, 1);
    const job = await getIngestStageJobById(h.ingestDb, "pj-1");
    assert.equal(job?.status, "dead_letter");
    assert.equal(job?.last_error_code, "ingest_stage.public_judgment_not_publishable");
    assert.equal(h.core.prepare("SELECT COUNT(*) n FROM article_publications_p3").get()?.n, 0, "no forced US publication");
  } finally { h.ingest.close(); h.core.close(); }
});

test("manual approval policy: US publishable/published without an explicit authorization is non-compliant", () => {
  assert.deepEqual(
    evaluateManualApprovalPolicy({ sourceKey: "us-scotus", collectionPublishable: true, reviewRequired: false, publishedP3: false, automaticApprovalRows: 0 }),
    { compliant: false, reason: "canary_lineage.us_publishable_without_manual_authorization", manualAuthorizationPresent: false },
  );
  assert.deepEqual(
    evaluateManualApprovalPolicy({ sourceKey: "us-scotus", collectionPublishable: false, reviewRequired: true, publishedP3: true, automaticApprovalRows: 0 }),
    { compliant: false, reason: "canary_lineage.us_published_without_manual_authorization", manualAuthorizationPresent: false },
  );
  assert.equal(
    evaluateManualApprovalPolicy({ sourceKey: "us-scotus", collectionPublishable: false, reviewRequired: true, publishedP3: false, automaticApprovalRows: 0 }).compliant,
    true,
  );
  // The automatic FR/ES approval ledger must NEVER be read as US manual consent.
  const withAutomaticRows = evaluateManualApprovalPolicy({ sourceKey: "us-scotus", collectionPublishable: true, reviewRequired: false, publishedP3: false, automaticApprovalRows: 5 });
  assert.equal(withAutomaticRows.compliant, false);
  assert.equal(withAutomaticRows.manualAuthorizationPresent, false);
  assert.equal(
    evaluateManualApprovalPolicy({ sourceKey: "de-bverfg", collectionPublishable: true, reviewRequired: false, publishedP3: true, automaticApprovalRows: 0 }).compliant,
    true,
  );
});

test("lineage audit requires succeeded status per exact stage and labels crawl-first discovery as not executed", () => {
  // Presence alone (blocked/failed/pending) is never success.
  const presenceOnly = evaluateSevenStageLineage([
    { stage: "crawl", status: "dead_letter" },
    { stage: "normalize", status: "pending" },
    { stage: "translate", status: "failed" },
  ]);
  assert.equal(presenceOnly.sevenStageComplete, false);
  assert.deepEqual(presenceOnly.verifiedStages, []);
  assert.equal(presenceOnly.missingStages.length, 7);

  // A crawl-first canary with all but discovery succeeded still cannot be 7/7.
  const canary = evaluateSevenStageLineage(
    ["crawl", "normalize", "translate", "public-judgment", "publish", "search"].map((stage) => ({ stage, status: "succeeded" })),
  );
  assert.equal(canary.sevenStageComplete, false);
  assert.equal(canary.discoveryNotExecutedByCanary, true);
  assert.deepEqual(canary.missingStages, ["discovery"]);

  const full = evaluateSevenStageLineage(SEVEN.map((stage) => ({ stage, status: "succeeded" })));
  assert.equal(full.sevenStageComplete, true);
});

test("lineage audit treats an unresolved native->core relation as NOT_OBSERVED, never success", () => {
  // A crawl job keyed only by native: cannot be observed via the core UUID alone.
  const unresolved = evaluateNativeCoreRelation({ crawlArticleId: "native:abc", coreArticleId: "11111111-1111-4111-8111-111111111111", advanceEventArticleIds: [] });
  assert.equal(unresolved.relation, "unresolved");
  assert.equal(unresolved.reason, "canary_lineage.native_core_relation_not_observed");

  // Fully resolved only via the observed normalize advance event.
  const resolved = evaluateNativeCoreRelation({
    crawlArticleId: "native:abc",
    coreArticleId: "11111111-1111-4111-8111-111111111111",
    advanceEventArticleIds: [{ fromArticleId: "native:abc", resolvedArticleId: "11111111-1111-4111-8111-111111111111" }],
  });
  assert.equal(resolved.relation, "resolved");
  assert.equal(resolved.coreArticleId, "11111111-1111-4111-8111-111111111111");

  // A non-native crawl id is not a canary crawl identity and stays unresolved.
  const nonNative = evaluateNativeCoreRelation({ crawlArticleId: "core-uuid", coreArticleId: "core-uuid", advanceEventArticleIds: [] });
  assert.equal(nonNative.relation, "unresolved");
});

test("lineage audit script rejects any non-SELECT statement", () => {
  assert.doesNotThrow(() => assertSelectOnly([{ name: "ok", database: "worldcons_core", sql: "SELECT id FROM articles LIMIT 1" }]));
  assert.throws(() => assertSelectOnly([{ name: "bad", database: "worldcons_core", sql: "UPDATE articles SET status='x'" }]), /non_select/);
  assert.throws(() => assertSelectOnly([{ name: "bad", database: "worldcons_core", sql: "SELECT 1; DROP TABLE articles" }]), /forbidden_keyword/);
});

test("canary route auth: fails closed when the dedicated token is unconfigured (and never uses BROWSER_RUN_TOKEN)", async () => {
  const request = (token?: string) => new Request("https://worldcons-ingest.cclib.workers.dev/v1/stage-canary", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  // Unconfigured: 401 even if the unrelated browser token is supplied.
  assert.equal(await operatorCanaryAuthorized(request("any"), { BROWSER_RUN_TOKEN: "browser" }), false);
  assert.equal(await operatorCanaryAuthorized(request(""), { WORLDCONS_CANARY_TOKEN: "canary-secret" }), false);
  // Incorrect token: fail closed.
  assert.equal(await operatorCanaryAuthorized(request("wrong"), { WORLDCONS_CANARY_TOKEN: "canary-secret" }), false);
  // Correct dedicated token: success.
  assert.equal(await operatorCanaryAuthorized(request("canary-secret"), { WORLDCONS_CANARY_TOKEN: "canary-secret" }), true);
  // A matching BROWSER_RUN_TOKEN is irrelevant: only the dedicated secret counts.
  assert.equal(await operatorCanaryAuthorized(request("browser"), { BROWSER_RUN_TOKEN: "browser" }), false);
});

test("operator canary workflow envelope: accepts the canonical DE and US payloads with strict defaults", () => {
  const de = parseOperatorCanaryEvent({
    sourceKey: "de-bverfg",
    candidateUrl: DE_URL,
    ecli: DE_ECLI,
  });
  assert.equal(de.ok, true);
  assert.deepEqual(de.ok ? de.value : null, {
    payloadKind: "seed", sourceKey: "de-bverfg", candidateUrl: DE_URL, ecli: DE_ECLI, operatorId: "cloudflare-workflow-operator", mode: "seed-and-dispatch",
  });

  const us = parseOperatorCanaryEvent({
    sourceKey: "us-scotus", candidateUrl: US_URL, docket: "26A388", operatorId: "ops:reviewer", mode: "seed",
  });
  assert.equal(us.ok, true);
  assert.deepEqual(us.ok ? us.value : null, {
    payloadKind: "seed", sourceKey: "us-scotus", candidateUrl: US_URL, docket: "26A388", operatorId: "ops:reviewer", mode: "seed",
  });

  // A JSON string envelope is accepted (Wrangler create may pass one).
  const asString = parseOperatorCanaryEvent(JSON.stringify({ sourceKey: "us-scotus", candidateUrl: US_URL, docket: "26A388" }));
  assert.equal(asString.ok, true);

  // The advance shape is discrimated by mode:'advance' and carries no source/URL.
  const advance = parseOperatorCanaryEvent({ mode: "advance", jobId: "db44b56c-b5d6-46cf-821f-693c09757f49", canaryId: "C121C7D71702D52251F439F7130F91BE" });
  assert.equal(advance.ok, true);
  assert.deepEqual(advance.ok ? advance.value : null, {
    payloadKind: "advance", mode: "advance", jobId: "db44b56c-b5d6-46cf-821f-693c09757f49", canaryId: "c121c7d71702d52251f439f7130f91be", operatorId: "cloudflare-workflow-operator",
  });
});

test("operator canary workflow envelope: fails closed on bad source, missing identity, unknown key/mode, and non-object", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /payload_not_object/],
    ["not json", /payload_not_json/],
    [{ sourceKey: "fr-conseil-constitutionnel", candidateUrl: DE_URL, ecli: DE_ECLI }, /source_not_allowed/],
    [{ sourceKey: "de-bverfg", candidateUrl: DE_URL }, /ecli_required_for_de/],
    [{ sourceKey: "us-scotus", candidateUrl: US_URL }, /docket_required_for_us/],
    [{ sourceKey: "de-bverfg", candidateUrl: DE_URL, ecli: DE_ECLI, limit: 5 }, /unknown_key:limit/],
    [{ sourceKey: "de-bverfg", candidateUrl: DE_URL, ecli: DE_ECLI, mode: "all" }, /mode_not_allowed/],
    [{ sourceKey: "de-bverfg", ecli: DE_ECLI }, /candidate_url_required/],
    [{ sourceKey: "de-bverfg", candidateUrl: `https://x.test/${"a".repeat(3000)}`, ecli: DE_ECLI }, /candidate_url_too_long/],
  ];
  for (const [payload, pattern] of cases) {
    const result = parseOperatorCanaryEvent(payload);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(payload)}`);
    assert.match(result.ok ? "" : result.error, pattern);
  }
});

test("operator canary workflow envelope: the advance shape strictly rejects bad/forged/mixed fields", () => {
  const cases: Array<[unknown, RegExp]> = [
    // A seed key on the advance shape is rejected (shapes never mix).
    [{ mode: "advance", jobId: "db44b56c-b5d6-46cf-821f-693c09757f49", canaryId: "a".repeat(32), sourceKey: "de-bverfg" }, /unknown_key:sourceKey/],
    [{ mode: "advance", jobId: "db44b56c-b5d6-46cf-821f-693c09757f49", canaryId: "a".repeat(32), candidateUrl: DE_URL }, /unknown_key:candidateUrl/],
    // Non-UUID jobId and non-32-hex canaryId are rejected.
    [{ mode: "advance", jobId: "not-a-uuid", canaryId: "a".repeat(32) }, /advance_job_id_invalid/],
    [{ mode: "advance", jobId: "db44b56c-b5d6-46cf-821f-693c09757f49", canaryId: "not-hex" }, /advance_canary_id_invalid/],
    [{ mode: "advance", canaryId: "a".repeat(32) }, /advance_job_id_invalid/],
    [{ mode: "advance", jobId: "db44b56c-b5d6-46cf-821f-693c09757f49" }, /advance_canary_id_invalid/],
    [{ mode: "advance", jobId: "db44b56c-b5d6-46cf-821f-693c09757f49", canaryId: "a".repeat(32), operatorId: "x".repeat(300) }, /operator_id_invalid/],
    // An unknown top-level key on either shape is rejected.
    [{ mode: "advance", jobId: "db44b56c-b5d6-46cf-821f-693c09757f49", canaryId: "a".repeat(32), extra: 1 }, /unknown_key:extra/],
  ];
  for (const [payload, pattern] of cases) {
    const result = parseOperatorCanaryEvent(payload);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(payload)}`);
    assert.match(result.ok ? "" : result.error, pattern);
  }
});

test("operator canary workflow: the canonical DE event plans and seeds exactly one crawl job, dispatch is optional", async () => {
  const h = createHarness();
  try {
    const parsed = parseOperatorCanaryEvent({ sourceKey: "de-bverfg", candidateUrl: DE_URL, ecli: DE_ECLI, mode: "seed-and-dispatch" });
    assert.equal(parsed.ok, true);
    if (!parsed.ok || parsed.value.payloadKind !== "seed") return;
    const plan = await planCanaryCase(
      { sourceKey: parsed.value.sourceKey, candidateUrl: parsed.value.candidateUrl, identifiers: { ecli: parsed.value.ecli } },
      { now: NOW },
    );
    assert.equal(plan.accepted, true);
    const seed = await seedCanaryCase(h.ingestDb, h.bucket, plan, {
      operatorId: parsed.value.operatorId, deploymentRef: null, now: NOW,
    });
    assert.equal(seed.outcome, "seeded");
    assert.ok(seed.jobId);
    // Immutable audit records the workflow operator identity.
    const audit = h.ingest.prepare("SELECT operator_id, outcome FROM ingest_stage_canary_records_v1").all() as Array<Record<string, unknown>>;
    assert.deepEqual({ ...audit[0] }, { operator_id: "cloudflare-workflow-operator", outcome: "seeded" });
    assert.equal(h.ingest.prepare("SELECT COUNT(*) n FROM ingest_stage_jobs").get()?.n, 1);
    assert.equal(h.core.prepare("SELECT COUNT(*) n FROM article_publications_p3").get()?.n, 0, "workflow never publishes");
  } finally { h.ingest.close(); h.core.close(); }
});
