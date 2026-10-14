import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  buildIngestStageIdempotencyKey,
  INGEST_STAGE_QUEUES,
  type IngestStage,
  type IngestStageQueueMessage,
} from "../lib/cloudflare/ingest-stages/contracts";
import { resolveIngestStageRolloutGate } from "../lib/cloudflare/ingest-stages/flags";
import { getIngestStageJobById, registerIngestStageJob } from "../lib/cloudflare/ingest-stages/repository";
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
import { dispatchIngestStagePass } from "../lib/cloudflare/ingest-stages/dispatcher";
import { NATIVE_CRAWLER_SOURCES } from "../workers/async-pipeline/src/native-crawler";
import {
  CANARY_DISCOVERY_MAX_LINKS,
  canaryDiscoveryDefaultRangeDays,
  canaryDiscoveryMaxLinks,
  parseCanaryDiscoveryRequest,
  selectCanaryDiscoveryCandidate,
} from "../lib/cloudflare/ingest-stages/canary-discovery";
import {
  BOOTSTRAP_DE_ONE_SOURCE_KEY,
  evaluateBootstrapDeOnePrecondition,
} from "../lib/cloudflare/ingest-stages/bootstrap-de-one";
import {
  consumeIngestStageBatch,
  type IngestStageQueueMessageHandle,
} from "../workers/async-pipeline/src/ingest-stage-consumer";
import { createIngestStageHandlers, enqueueCanaryDiscovery, enqueueIngestStageDiscovery } from "../workers/async-pipeline/src/ingest-stage-handlers";
import { operatorCanaryAuthorized } from "../workers/async-pipeline/src/worker-auth";
import { approvalIdentity, HUMAN_APPROVAL_POLICY } from "../lib/cloudflare/e2e/contracts";
import { approvalSourceMetadata } from "../lib/cloudflare/core-write/authority";
import {
  applyOfficialIdentityGate,
  assertSelectOnly,
  classifyPublication,
  evaluateLinkedLineage,
  evaluateManualApprovalPolicy,
  evaluateNativeCoreRelation,
  evaluateSearchProjection,
  parseJobId,
} from "../scripts/audit-worldcons-canary-lineage";
import type { NativeCrawlerBindings } from "../workers/async-pipeline/src/native-crawler";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";

const NOW = "2026-10-13T00:00:00.000Z";
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
  "0004_e2e_generations.sql",
  "0007_e2e_verification.sql",
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

function canaryHandlers(harness: Harness, adapters: {
  publication?: Parameters<typeof createIngestStageHandlers>[0]["publication"];
  search?: Parameters<typeof createIngestStageHandlers>[0]["search"];
} = {}) {
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
    ...(adapters.publication ? { publication: adapters.publication } : {}),
    ...(adapters.search ? { search: adapters.search } : {}),
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

test("US manual-approval guard: a legacy published US row with publishable=1 and old P3 but NO human receipt is BLOCKED and cannot trigger publish/search", async () => {
  const h = createHarness();
  const LEGACY = "4b3d5644-2681-449e-8ad5-28ee2defffe8";
  try {
    // Simulate the real incident: a 2026-Sep legacy US article that was already
    // published with collection.publishable=1, review_state summarized, and a
    // verified officialPdf — but NO immutable human-approval receipt.
    const legacyMetadata = JSON.stringify({
      officialPdf: { url: US_URL, r2Key: `artifacts/scotus_pdf/${"0".repeat(64)}.pdf`, sha256: "0".repeat(64), docketVerified: true },
      collection: { publishable: true, sourceTextAvailable: true, sourceUrlVerified: true, strategy: "official-pdf" },
      review: { required: true },
    });
    h.core.prepare("INSERT INTO articles (id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,status,slug,cleaned_text,summary_json,korean_title,translation_status,source_metadata,content_hash,review_state,discovered_at,fetched_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(LEGACY, "us-scotus", "United States", "Supreme Court of the United States", "opinion", US_URL, US_URL, "en", "t", "summarized", "us-legacy",
        "legacy approved opinion text ".repeat(40), JSON.stringify({ summary: { coreSummary: ["기존 요약"] } }), "요약", "translated",
        legacyMetadata, "legacy-hash", "summarized", NOW, NOW, NOW, NOW);
    // The legacy P3 publication that must never count as authorization.
    h.core.prepare("INSERT INTO article_publications_p3 (id,article_id,version_id,state,revision,decided_by_type,reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("pub-legacy", LEGACY, "ver-legacy", "published", 1, "human", "legacy", NOW, NOW);

    const handlers = canaryHandlers(h, {
      publication: { async publish() { return { published: true, versionId: "never", state: "published" }; } },
      search: { async project() { return { projected: true, documentCount: 1, ftsCount: 1 }; } },
    });
    const gate = resolveIngestStageRolloutGate(true, "production", "public-judgment,publish,search");
    // A public-judgment job for the legacy US article.
    h.ingest.prepare("INSERT INTO ingest_stage_jobs (id,idempotency_key,stage,article_id,source_key,source_version,content_hash,status,priority,attempt_count,max_attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("pj-us", buildIngestStageIdempotencyKey({ articleId: LEGACY, stage: "public-judgment", sourceVersion: "v", contentHash: "h" }), "public-judgment", LEGACY, "us-scotus", "v", "h", "pending", 0, 0, 8, NOW, NOW);
    const sent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({
      ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } },
      jobId: "pj-us", canaryId: "us", operatorId: "op", deploymentRef: "test", stage: "public-judgment", now: NOW,
    });
    const result = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES["public-judgment"], messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
      gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
      sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: [] }),
    });
    assert.equal(result.completed, 0);
    assert.equal(result.blockedJobs, 1, JSON.stringify(result));
    const pjJob = await getIngestStageJobById(h.ingestDb, "pj-us");
    assert.equal(pjJob?.status, "dead_letter");
    assert.equal(pjJob?.last_error_code, "ingest_stage.us_manual_approval_receipt_required");
    assert.equal(h.core.prepare("SELECT COUNT(*) n FROM article_publications_p3 WHERE state='published'").get()?.n, 1, "the legacy P3 row is untouched");
    // No publish/search child job was registered by the blocked public-judgment.
    assert.equal(h.ingest.prepare("SELECT COUNT(*) n FROM ingest_stage_jobs WHERE stage IN ('publish','search')").get()?.n, 0, "no publish/search is triggered");

    // Defense in depth: a standalone US publish AND search job are independently blocked.
    for (const stage of ["publish", "search"] as const) {
      h.ingest.prepare("INSERT INTO ingest_stage_jobs (id,idempotency_key,stage,article_id,source_key,source_version,content_hash,status,priority,attempt_count,max_attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(`${stage}-us`, buildIngestStageIdempotencyKey({ articleId: LEGACY, stage, sourceVersion: "v", contentHash: "h" }), stage, LEGACY, "us-scotus", "v", "h", "pending", 0, 0, 8, NOW, NOW);
      const stageSent: IngestStageQueueMessage[] = [];
      await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { stageSent.push(body); return {}; } }, jobId: `${stage}-us`, canaryId: "us", operatorId: "op", deploymentRef: "test", stage, now: NOW });
      const stageResult = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES[stage], messages: [{ body: stageSent[0], ack: () => undefined, retry: () => undefined }] }, {
        gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
        sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: [] }),
      });
      assert.equal(stageResult.blockedJobs, 1, `${stage} must be blocked`);
      assert.equal((await getIngestStageJobById(h.ingestDb, `${stage}-us`))?.last_error_code, "ingest_stage.us_manual_approval_receipt_required");
    }
    assert.equal(h.core.prepare("SELECT COUNT(*) n FROM article_publications_p3 WHERE state='published'").get()?.n, 1, "no new US publication");
  } finally { h.ingest.close(); h.core.close(); }
});

test("US manual-approval guard: a valid, same-case, snapshot-bound human receipt opens public judgment; a stale/unbound receipt fails closed", async () => {
  const h = createHarness();
  const CORE = "a60db8bb-4ec3-4ecf-bb5a-6245f621a334";
  try {
    const metadata = JSON.stringify({
      officialPdf: { url: US_URL, r2Key: `artifacts/scotus_pdf/${"1".repeat(64)}.pdf`, sha256: "1".repeat(64), docketVerified: true },
      collection: { publishable: true, sourceTextAvailable: true, sourceUrlVerified: true, strategy: "official-pdf" },
      review: { required: true },
    });
    h.core.prepare("INSERT INTO articles (id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,status,slug,cleaned_text,summary_json,korean_title,translation_status,source_metadata,content_hash,review_state,discovered_at,fetched_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(CORE, "us-scotus", "United States", "Supreme Court of the United States", "opinion", US_URL, US_URL, "en", "t", "summarized", "us-guard",
        "verified us opinion text ".repeat(40), JSON.stringify({ summary: { coreSummary: ["요약"] } }), "요약", "translated",
        metadata, "valid-hash", "unreviewed", NOW, NOW, NOW, NOW);
    const row = h.core.prepare("SELECT * FROM articles WHERE id=?").get(CORE) as Record<string, unknown>;
    const snapshot = { ...row, source_metadata: approvalSourceMetadata(row.source_metadata, true) };
    const identity = await approvalIdentity(CORE, snapshot, HUMAN_APPROVAL_POLICY);

    const handlers = canaryHandlers(h);
    const gate = resolveIngestStageRolloutGate(true, "production", "public-judgment");
    const consumePublicJudgment = async (jobId: string) => {
      const sent: IngestStageQueueMessage[] = [];
      await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } }, jobId, canaryId: "us", operatorId: "op", deploymentRef: "test", stage: "public-judgment", now: NOW });
      return consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES["public-judgment"], messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
        gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
        sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: [] }),
      });
    };
    const insertPjJob = (id: string) => h.ingest.prepare("INSERT INTO ingest_stage_jobs (id,idempotency_key,stage,article_id,source_key,source_version,content_hash,status,priority,attempt_count,max_attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, buildIngestStageIdempotencyKey({ articleId: CORE, stage: "public-judgment", sourceVersion: id, contentHash: "h" }), "public-judgment", CORE, "us-scotus", id, "h", "pending", 0, 0, 8, NOW, NOW);

    // 1) A receipt with a synthetically-correct policy/schema/actor but a stale
    //    snapshot hash must NOT authenticate.
    h.core.prepare("INSERT INTO e2e_approval_evidence_v1 (approval_key,article_id,approval_snapshot_hash,source_content_hash,policy_version,evidence_ref,source_artifact_ref,source_artifact_hash,discovery_candidate_id,pipeline_run_id,evidence_document,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("stale-key", CORE, "deadbeef".repeat(8), identity.sourceContentHash, HUMAN_APPROVAL_POLICY, "core:e2e-approval:stale", "core:e2e-reviewed-source:stale", "x", "manual:" + CORE, "review:stale",
        JSON.stringify({ schema: "worldcons.human-approval.v1", actorId: "ops:forged", approvalSnapshotHash: "deadbeef".repeat(8), sourceContentHash: identity.sourceContentHash }), NOW);
    insertPjJob("pj-stale");
    const stale = await consumePublicJudgment("pj-stale");
    assert.equal(stale.blockedJobs, 1, JSON.stringify(stale));
    assert.equal((await getIngestStageJobById(h.ingestDb, "pj-stale"))?.last_error_code, "ingest_stage.us_manual_approval_unauthenticated");

    // 2) A genuine same-case receipt bound to the CURRENT snapshot opens the gate.
    h.core.prepare("DELETE FROM e2e_approval_evidence_v1 WHERE approval_key=?").run("stale-key");
    h.core.prepare("INSERT INTO e2e_approval_evidence_v1 (approval_key,article_id,approval_snapshot_hash,source_content_hash,policy_version,evidence_ref,source_artifact_ref,source_artifact_hash,discovery_candidate_id,pipeline_run_id,evidence_document,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("valid-key", CORE, identity.approvalSnapshotHash, identity.sourceContentHash, HUMAN_APPROVAL_POLICY, `core:e2e-approval:${identity.approvalKey}`, "core:e2e-reviewed-source:valid", "x", "manual:" + CORE, "review:valid",
        JSON.stringify({ schema: "worldcons.human-approval.v1", actorId: "ops:reviewer", approvalSnapshotHash: identity.approvalSnapshotHash, sourceContentHash: identity.sourceContentHash }), NOW);
    insertPjJob("pj-valid");
    const valid = await consumePublicJudgment("pj-valid");
    assert.equal(valid.completed, 1, JSON.stringify(valid));

    // 3) The automatic FR/ES ledger policy for the same article must NOT count.
    h.core.prepare("DELETE FROM e2e_approval_evidence_v1 WHERE approval_key=?").run("valid-key");
    h.core.prepare("INSERT INTO e2e_approval_evidence_v1 (approval_key,article_id,approval_snapshot_hash,source_content_hash,policy_version,evidence_ref,source_artifact_ref,source_artifact_hash,discovery_candidate_id,pipeline_run_id,evidence_document,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("auto-key", CORE, identity.approvalSnapshotHash, identity.sourceContentHash, "worldcons.fr-es-staged-approval.v1", "core:e2e-approval:auto", "core:e2e-reviewed-source:auto", "x", "manual:" + CORE, "review:auto",
        JSON.stringify({ schema: "worldcons.human-approval.v1", actorId: "ops:auto", approvalSnapshotHash: identity.approvalSnapshotHash }), NOW);
    insertPjJob("pj-auto");
    const auto = await consumePublicJudgment("pj-auto");
    assert.equal(auto.blockedJobs, 1, JSON.stringify(auto));
    assert.equal((await getIngestStageJobById(h.ingestDb, "pj-auto"))?.last_error_code, "ingest_stage.us_manual_approval_receipt_required");
  } finally { h.ingest.close(); h.core.close(); }
});

test("US manual-approval guard: a native (unresolved) US publish/search id is an EXPLICIT terminal block and cannot bypass the guard", async () => {
  const h = createHarness();
  try {
    // No core article exists for the native id, so if the guard were bypassed the
    // adapter would happily "publish"/"project" — the test adapter proves it must
    // never be reached.
    let publishCalled = false;
    let searchCalled = false;
    const handlers = canaryHandlers(h, {
      publication: { async publish() { publishCalled = true; return { published: true, versionId: "v", state: "published" }; } },
      search: { async project() { searchCalled = true; return { projected: true, documentCount: 1, ftsCount: 1 }; } },
    });
    const gate = resolveIngestStageRolloutGate(true, "production", "publish,search");
    const NATIVE = "native:us-unresolved-abc123";
    for (const stage of ["publish", "search"] as const) {
      h.ingest.prepare("INSERT INTO ingest_stage_jobs (id,idempotency_key,stage,article_id,source_key,source_version,content_hash,status,priority,attempt_count,max_attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(`${stage}-native-us`, buildIngestStageIdempotencyKey({ articleId: NATIVE, stage, sourceVersion: "v", contentHash: "h" }), stage, NATIVE, "us-scotus", "v", "h", "pending", 0, 0, 8, NOW, NOW);
      const sent: IngestStageQueueMessage[] = [];
      await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } }, jobId: `${stage}-native-us`, canaryId: "us", operatorId: "op", deploymentRef: "test", stage, now: NOW });
      const result = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES[stage], messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
        gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
        sourceGate: () => true,
      });
      assert.equal(result.blockedJobs, 1, `${stage} native US id must be blocked: ${JSON.stringify(result)}`);
      assert.equal((await getIngestStageJobById(h.ingestDb, `${stage}-native-us`))?.last_error_code, `ingest_stage.${stage}_us_article_unresolved`);
    }
    assert.equal(publishCalled, false, "the publication adapter must never be reached for an unresolved US id");
    assert.equal(searchCalled, false, "the search adapter must never be reached for an unresolved US id");
    assert.equal(h.core.prepare("SELECT COUNT(*) n FROM article_publications_p3").get()?.n, 0, "no US publication");
  } finally { h.ingest.close(); h.core.close(); }
});

test("US manual-approval guard is a no-op for DE / protected FR-ES so existing non-US flows are unaffected", async () => {  const h = createHarness();
  try {
    h.core.prepare("INSERT INTO articles (id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,status,slug,cleaned_text,summary_json,korean_title,translation_status,source_metadata,content_hash,review_state,discovered_at,fetched_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("de-article", "de-bverfg", "Germany", "Federal Constitutional Court of Germany", "decision", "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rk20260905_2bvr135824.html", "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rk20260905_2bvr135824.html", "de", "t", "summarized", "de-1",
        "verified de decision text ".repeat(40), JSON.stringify({ summary: { coreSummary: ["요약"] } }), "요약", "translated",
        JSON.stringify({ collection: { publishable: true, sourceTextAvailable: true, sourceUrlVerified: true, strategy: "fetch" } }), "de-hash", "unreviewed", NOW, NOW, NOW, NOW);
    const handlers = canaryHandlers(h);
    const gate = resolveIngestStageRolloutGate(true, "production", "public-judgment");
    h.ingest.prepare("INSERT INTO ingest_stage_jobs (id,idempotency_key,stage,article_id,source_key,source_version,content_hash,status,priority,attempt_count,max_attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("pj-de", buildIngestStageIdempotencyKey({ articleId: "de-article", stage: "public-judgment", sourceVersion: "v", contentHash: "h" }), "public-judgment", "de-article", "de-bverfg", "v", "h", "pending", 0, 0, 8, NOW, NOW);
    const sent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } }, jobId: "pj-de", canaryId: "de", operatorId: "op", deploymentRef: "test", stage: "public-judgment", now: NOW });
    const result = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES["public-judgment"], messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
      gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
      sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: [] }),
    });
    assert.equal(result.completed, 1, `DE public judgment must still succeed: ${JSON.stringify(result)}`);
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
    // The US manual-approval guard fires first and blocks before the generic
    // publishability check; either way the US article is never published.
    assert.equal(job?.last_error_code, "ingest_stage.us_manual_approval_receipt_required");
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
  // Only an immutable, same-case, snapshot-bound human-review receipt may
  // authorize US publication. A merely-present policy/schema/actor is not enough.
  const withUnboundReceipt = evaluateManualApprovalPolicy({
    sourceKey: "us-scotus", collectionPublishable: true, reviewRequired: false, publishedP3: true, automaticApprovalRows: 0,
    manualApprovalReceipt: { present: true, authenticated: false, reason: "us_manual_approval.receipt_snapshot_mismatch", actorId: "ops:reviewer", policyVersion: "worldcons.human-reviewed-publication.v1" },
  });
  assert.equal(withUnboundReceipt.compliant, false, "a synthetically-present but unauthenticated receipt must not authorize");
  assert.equal(withUnboundReceipt.manualAuthorizationPresent, false);
  const withReceipt = evaluateManualApprovalPolicy({
    sourceKey: "us-scotus", collectionPublishable: true, reviewRequired: false, publishedP3: true, automaticApprovalRows: 0,
    manualApprovalReceipt: { present: true, authenticated: true, reason: "us_manual_approval.same_case_snapshot_bound_human_receipt", actorId: "ops:reviewer", policyVersion: "worldcons.human-reviewed-publication.v1" },
  });
  assert.equal(withReceipt.compliant, true);
  assert.equal(withReceipt.manualAuthorizationPresent, true);
  assert.equal(withReceipt.reason, "canary_lineage.us_manual_receipt_authenticated");
  assert.equal(
    evaluateManualApprovalPolicy({ sourceKey: "de-bverfg", collectionPublishable: true, reviewRequired: false, publishedP3: true, automaticApprovalRows: 0 }).compliant,
    true,
  );
});

test("linked lineage: a real six-stage canary chain is verified and never claims a fake discovery 7/7", () => {
  const NATIVE = "native:abc123";
  const CORE = "a60db8bb-4ec3-4ecf-bb5a-6245f621a334";
  const SRC = "de-bverfg";
  const stage = (name: string, articleId: string) => ({ stage: name, jobId: `${name}-job`, articleId, sourceKey: SRC, status: "succeeded" });
  const chain = [
    stage("crawl", NATIVE),
    { ...stage("normalize", NATIVE), resultRef: CORE },
    stage("translate", CORE),
    stage("public-judgment", CORE),
    stage("publish", CORE),
    stage("search", CORE),
  ];
  const result = evaluateLinkedLineage(chain);
  assert.equal(result.ok, true, result.reason ?? "");
  assert.deepEqual(result.verifiedStages, ["crawl", "normalize", "translate", "public-judgment", "publish", "search"]);
  assert.equal(result.stagedChainComplete, true);
  assert.equal(result.discoveryExecuted, false);
  assert.equal(result.sevenStageComplete, false, "crawl-first canary can never be a literal 7/7");
  assert.deepEqual(result.missingStages, ["discovery"]);
  assert.equal(result.nativeArticleId, NATIVE);
  assert.equal(result.coreArticleId, CORE);
  assert.equal(result.nativeCoreRelation, "resolved");

  // A genuine discovery row (never fabricated) makes it a true 7/7.
  const withDiscovery = evaluateLinkedLineage([stage("discovery", "native:disc"), ...chain]);
  assert.equal(withDiscovery.sevenStageComplete, true);
  assert.equal(withDiscovery.discoveryExecuted, true);
});

test("linked lineage: fails closed on a broken chain, non-succeeded stage, mixed/foreign source, duplicates and order", () => {
  const SRC = "de-bverfg";
  const job = (name: string, articleId: string, status = "succeeded", sourceKey: string | null = SRC) => ({ stage: name, jobId: `${name}-${articleId}`, articleId, sourceKey, status });

  // A later stage not succeeded breaks the whole chain.
  const broken = evaluateLinkedLineage([
    job("crawl", "native:x"), job("normalize", "core-uuid", "pending"),
  ]);
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, "canary_lineage.chain_stage_not_succeeded");

  // A crawl job of another source mixed into the chain is rejected.
  const mixed = evaluateLinkedLineage([
    job("crawl", "native:x", "succeeded", "de-bverfg"),
    job("normalize", "core-uuid", "succeeded", "us-scotus"),
  ]);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.reason, "canary_lineage.chain_mixed_source");

  // A non-canary source chain is rejected outright.
  const foreign = evaluateLinkedLineage([job("crawl", "native:x", "succeeded", "fr-conseil-constitutionnel")]);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, "canary_lineage.chain_non_canary_source");

  // Duplicate stage rows and out-of-order stages are rejected.
  const duplicate = evaluateLinkedLineage([job("crawl", "a"), job("crawl", "b")]);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, "canary_lineage.chain_stage_duplicate");
  const outOfOrder = evaluateLinkedLineage([job("normalize", "core"), job("crawl", "native:x")]);
  assert.equal(outOfOrder.ok, false);
  assert.equal(outOfOrder.reason, "canary_lineage.chain_out_of_order");

  // Empty chain is fail-closed.
  assert.equal(evaluateLinkedLineage([]).reason, "canary_lineage.chain_empty");
});

test("linked lineage: an unresolved native->core chain never reports a core UUID or 7/7", () => {
  // Crawl only: no later stage observed -> stagedChainComplete false, relation unresolved.
  const crawlOnly = evaluateLinkedLineage([
    { stage: "crawl", jobId: "c", articleId: "native:abc", sourceKey: "us-scotus", status: "succeeded" },
  ]);
  assert.equal(crawlOnly.ok, true);
  assert.equal(crawlOnly.coreArticleId, null);
  assert.equal(crawlOnly.nativeCoreRelation, "unresolved");
  assert.equal(crawlOnly.stagedChainComplete, false);
  assert.equal(crawlOnly.sevenStageComplete, false);
});

test("linked US Crawl->Normalize resolves a preserved Core UUID without attributing old publication", () => {
  const NATIVE = "native:1815486b51fa7a9a07b377bf50274a69";
  const CORE = "4b3d5644-2681-449e-8ad5-28ee2defffe8";
  const result = evaluateLinkedLineage([
    { stage: "crawl", jobId: "crawl", articleId: NATIVE, sourceKey: "us-scotus", status: "succeeded" },
    { stage: "normalize", jobId: "normalize", articleId: NATIVE, resultRef: CORE, sourceKey: "us-scotus", status: "succeeded" },
  ]);
  assert.equal(result.coreArticleId, CORE);
  assert.equal(result.nativeCoreRelation, "resolved");
  assert.equal(result.stagedChainComplete, false);
  assert.equal(result.sevenStageComplete, false);
  const proof = evaluateNativeCoreRelation({ crawlArticleId: NATIVE, coreArticleId: null,
    normalizeArticleId: NATIVE, normalizeResultRef: CORE, advanceEventArticleIds: [] });
  assert.equal(proof.relation, "resolved");
  assert.equal(proof.reason, "canary_lineage.native_core_resolved_via_normalize_result");
  const mismatch = evaluateNativeCoreRelation({ crawlArticleId: NATIVE, coreArticleId: null,
    normalizeArticleId: "native:other", normalizeResultRef: CORE, advanceEventArticleIds: [] });
  assert.equal(mismatch.relation, "unresolved");
});

test("lineage audit treats an unresolved native->core relation as NOT_OBSERVED, never success", () => {
  const unresolved = evaluateNativeCoreRelation({ crawlArticleId: "native:abc", coreArticleId: "11111111-1111-4111-8111-111111111111", advanceEventArticleIds: [] });
  assert.equal(unresolved.relation, "unresolved");
  assert.equal(unresolved.reason, "canary_lineage.native_core_relation_not_observed");

  const resolved = evaluateNativeCoreRelation({
    crawlArticleId: "native:abc",
    coreArticleId: "11111111-1111-4111-8111-111111111111",
    advanceEventArticleIds: [{ fromArticleId: "native:abc", resolvedArticleId: "11111111-1111-4111-8111-111111111111" }],
  });
  assert.equal(resolved.relation, "resolved");
  assert.equal(resolved.coreArticleId, "11111111-1111-4111-8111-111111111111");

  const nonNative = evaluateNativeCoreRelation({ crawlArticleId: "core-uuid", coreArticleId: "core-uuid", advanceEventArticleIds: [] });
  assert.equal(nonNative.relation, "unresolved");
});

test("search projection proof requires search_documents AND search_fts with the same article and rowid", () => {
  const same = evaluateSearchProjection({ documents: { articleId: "a", rowid: 16847, state: "published" }, fts: { articleId: "a", rowid: 16847 } });
  assert.equal(same.verified, true);
  assert.equal(same.publicationState, "published");
  // Different rowids are not a verified projection.
  assert.equal(evaluateSearchProjection({ documents: { articleId: "a", rowid: 16847 }, fts: { articleId: "a", rowid: 999 } }).verified, false);
  // Different articles are not a verified projection.
  assert.equal(evaluateSearchProjection({ documents: { articleId: "a", rowid: 1 }, fts: { articleId: "b", rowid: 1 } }).verified, false);
  // Missing one side is unobserved.
  assert.equal(evaluateSearchProjection({ documents: { articleId: "a", rowid: 1 }, fts: null }).verified, false);
  assert.equal(evaluateSearchProjection({ documents: null, fts: { articleId: "a", rowid: 1 } }).verified, false);
});

test("publication classification: an old published case without a chain publish is legacy_published_preexisting, never staged", () => {
  // US: pre-existing published P3 but the 2026-10-13 chain has no publish stage.
  assert.deepEqual(classifyPublication({ chainHasPublishSucceeded: false, p3Published: true }), { classification: "legacy_published_preexisting" });
  // A real chain publish + P3 published = staged.
  assert.deepEqual(classifyPublication({ chainHasPublishSucceeded: true, p3Published: true }), { classification: "staged_publication" });
  assert.deepEqual(classifyPublication({ chainHasPublishSucceeded: false, p3Published: false }), { classification: "not_published" });
  assert.deepEqual(classifyPublication({ chainHasPublishSucceeded: true, p3Published: false }), { classification: "chain_publish_without_p3" });
});

test("lineage audit rejects any non-SELECT statement and any malformed job id", () => {
  assert.doesNotThrow(() => assertSelectOnly([{ name: "ok", database: "worldcons_core", sql: "SELECT id FROM articles LIMIT 1" }]));
  assert.throws(() => assertSelectOnly([{ name: "bad", database: "worldcons_core", sql: "UPDATE articles SET status='x'" }]), /non_select/);
  assert.throws(() => assertSelectOnly([{ name: "bad", database: "worldcons_core", sql: "SELECT 1; DROP TABLE articles" }]), /forbidden_keyword/);
  // Job id validation is fail-closed; a malformed id is never interpolated.
  assert.equal(parseJobId("not-a-uuid").ok, false);
  assert.equal(parseJobId("'; DROP TABLE ingest_stage_jobs;").ok, false);
  assert.equal(parseJobId("db44b56c-b5d6-46cf-821f-693c09757f49").ok, true);
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

// ---------------------------------------------------------------------------
// discover-one canary (Germany only): a genuine official-homepage discovery job
// that yields exactly one corresponding canary crawl job with same-case
// provenance, continuing via the existing advance mode.
// ---------------------------------------------------------------------------

const DE_HOMEPAGE = "https://www.bundesverfassungsgericht.de/";
const DE_DISCOVERED_URL = "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rk20260923_2bvr168126.html?nn=68112";
const DE_DISCOVERED_ECLI = "ECLI:DE:BVerfG:2026:rk20260923.2bvr168126";

/** The real production robots policy: root allowed, /SiteGlobals/ disallowed. */
const DE_ROBOTS = "User-agent: *\nDisallow: /SiteGlobals/\nCrawl-delay: 0";

/** Minimal self-contained text PDF; exercises real unpdf parsing without network fixtures. */
function scotusPdfFixture(docket = "26A388", paragraphs = 36): Uint8Array<ArrayBuffer> {
  const content = [
    "BT /F1 12 Tf 50 770 Td",
    `(No. ${docket}) Tj 0 -18 Td`,
    ...Array.from({ length: paragraphs }, (_, i) => `(The Court applies constitutional doctrine to the official record in paragraph ${i + 1}.) Tj 0 -18 Td`),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let data = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(data.length);
    data += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const startxref = data.length;
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) data += `${String(offset).padStart(10, "0")} 00000 n \n`;
  data += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  const encoded = new TextEncoder().encode(data);
  const bytes = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  bytes.set(encoded);
  return bytes;
}

function deHomepageFetch(options: { links?: number; bodyEcli?: string; homepageHtml?: string } = {}): { fetch: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const linkCount = options.links ?? 1;
  const links = Array.from({ length: linkCount }, (_, index) => {
    const day = String(23 - index).padStart(2, "0");
    const ecli = index === 0 ? DE_DISCOVERED_ECLI : `ECLI:DE:BVerfG:2026:rk202609${day}.2bvr16812${index}`;
    const url = index === 0 ? DE_DISCOVERED_URL
      : `https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/09/rk202609${day}_2bvr16812${index}.html`;
    return `<a href="${url}">2 BvR 1681/2${index}, decision of ${day} September 2026 (${ecli})</a>`;
  }).join("");
  const homepageHtml = options.homepageHtml ?? `<html><main>${links}</main></html>`;
  const bodyEcli = options.bodyEcli ?? DE_DISCOVERED_ECLI;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/robots.txt")) return new Response(DE_ROBOTS, { status: 200, headers: { "content-type": "text/plain" } });
    if (url === DE_HOMEPAGE) return new Response(homepageHtml, { status: 200, headers: { "content-type": "text/html" } });
    // The JS-only decisions landing page carries no usable links in any fixture.
    if (url === "https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html") {
      return new Response("<html><main>no static decision links</main></html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    // A discovery-only third-party index must never be needed when the homepage
    // yields candidates; an empty page keeps the fallback inert and honest.
    if (url.startsWith("https://de.openlegaldata.io/api/cases/")) {
      return new Response(JSON.stringify({ next: null, results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith(DE_DISCOVERED_URL.split("?")[0])) {
      return new Response(`<html><main>${bodyEcli}\n${"BVerfG official decision text. ".repeat(80)}</main></html>`, { status: 200, headers: { "content-type": "text/html" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch: fetcher, seen };
}

function canaryDiscoveryHandlers(harness: Harness, fetcher: typeof fetch, adapters: {
  translation?: Parameters<typeof createIngestStageHandlers>[0]["translation"];
  publication?: Parameters<typeof createIngestStageHandlers>[0]["publication"];
  search?: Parameters<typeof createIngestStageHandlers>[0]["search"];
} = {}) {
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
    fetch: fetcher,
    now: () => NOW,
    canarySources: ["de-bverfg", "us-scotus"],
    ...(adapters.translation ? { translation: adapters.translation } : {}),
    ...(adapters.publication ? { publication: adapters.publication } : {}),
    ...(adapters.search ? { search: adapters.search } : {}),
  });
}

function deHomepageMessage(ingestDb: D1RuntimeDatabase, rawBucket: { put(key: string, value: Uint8Array): Promise<unknown> }, canaryId: string) {
  return enqueueCanaryDiscovery(ingestDb, rawBucket as Parameters<typeof enqueueCanaryDiscovery>[1], {
    sourceKey: "de-bverfg", canaryId, operatorId: "ops:reviewer", now: NOW,
  });
}

const STAGED = ["fr-conseil-constitutionnel", "es-tribunal-constitucional"];

test("discover-one contract: DE/US only, limit exactly 1, unknown keys/range rejected", () => {
  const good = parseCanaryDiscoveryRequest({
    sourceKey: "de-bverfg", limit: 1, rangeDays: 60, canaryDiscovery: { canaryId: "a".repeat(32), operatorId: "ops" },
  });
  assert.equal(good.ok, true);
  if (good.ok) assert.deepEqual(good.value.canaryDiscovery, { canaryId: "a".repeat(32), operatorId: "ops" });
  // The United States is now an accepted genuine discover-one source.
  assert.equal(parseCanaryDiscoveryRequest({
    sourceKey: "us-scotus", limit: 1, rangeDays: 400, canaryDiscovery: { canaryId: "a".repeat(32), operatorId: "ops" },
  }).ok, true);

  const cases: Array<[unknown, RegExp]> = [
    [{ sourceKey: "fr-conseil-constitutionnel", limit: 1, rangeDays: 60, canaryDiscovery: { canaryId: "a".repeat(32), operatorId: "ops" } }, /source_not_allowed/],
    [{ sourceKey: "es-tribunal-constitucional", limit: 1, rangeDays: 60, canaryDiscovery: { canaryId: "a".repeat(32), operatorId: "ops" } }, /source_not_allowed/],
    [{ sourceKey: "de-bverfg", limit: 2, rangeDays: 60, canaryDiscovery: { canaryId: "a".repeat(32), operatorId: "ops" } }, /limit_must_be_one/],
    [{ sourceKey: "de-bverfg", limit: 1, rangeDays: 0, canaryDiscovery: { canaryId: "a".repeat(32), operatorId: "ops" } }, /range_days_invalid/],
    [{ sourceKey: "de-bverfg", limit: 1, rangeDays: 60, canaryDiscovery: { canaryId: "a".repeat(32), operatorId: "ops" }, candidateUrl: DE_URL }, /unknown_key:candidateUrl/],
    [{ sourceKey: "de-bverfg", limit: 1, rangeDays: 60, canaryDiscovery: { canaryId: "nope", operatorId: "ops" } }, /canary_id_invalid/],
    [{ sourceKey: "de-bverfg", limit: 1, rangeDays: 60, canaryDiscovery: { canaryId: "a".repeat(32) } }, /operator_id_invalid/],
    [{ sourceKey: "de-bverfg", limit: 1, rangeDays: 60, canaryDiscovery: { canaryId: "a".repeat(32), operatorId: "ops", extra: 1 } }, /marker.unknown_key:extra/],
    [{ sourceKey: "de-bverfg", limit: 1, rangeDays: 60 }, /marker_missing/],
  ];
  for (const [payload, pattern] of cases) {
    const result = parseCanaryDiscoveryRequest(payload);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(payload)}`);
    assert.match(result.ok ? "" : result.error, pattern);
  }

  // selectCanaryDiscoveryCandidate: none -> candidate_not_found; over the finite
  // bound -> too_many_links; a bounded set picks exactly the first (newest).
  assert.equal(selectCanaryDiscoveryCandidate([]).reason, "canary_discovery.candidate_not_found");
  assert.equal(selectCanaryDiscoveryCandidate(new Array(CANARY_DISCOVERY_MAX_LINKS + 1).fill(1)).reason, "canary_discovery.too_many_links");
  const bounded = selectCanaryDiscoveryCandidate(["a", "b", "c"]);
  assert.equal(bounded.candidate, "a");
  assert.equal(bounded.observed, 3);
  // The US term listing legitimately exceeds the DE bound but stays under its own.
  assert.equal(selectCanaryDiscoveryCandidate(new Array(50).fill(1), canaryDiscoveryMaxLinks("us-scotus")).reason, null);
  assert.equal(canaryDiscoveryMaxLinks("us-scotus") > CANARY_DISCOVERY_MAX_LINKS, true);
  assert.equal(canaryDiscoveryDefaultRangeDays("us-scotus") >= canaryDiscoveryDefaultRangeDays("de-bverfg"), true);
});

test("discover-one payload: Workflow accepts DE+US, rejects unknown keys/range, carries no candidate", () => {
  const good = parseOperatorCanaryEvent({ mode: "discover-one", sourceKey: "de-bverfg" });
  assert.equal(good.ok, true);
  assert.deepEqual(good.ok ? good.value : null, {
    payloadKind: "discover-one", mode: "discover-one", sourceKey: "de-bverfg", rangeDays: 60,
    operatorId: "cloudflare-workflow-operator", dispatch: true,
  });
  const noDispatch = parseOperatorCanaryEvent({ mode: "discover-one", sourceKey: "de-bverfg", dispatch: false, rangeDays: 90 });
  assert.equal(noDispatch.ok, true);
  if (noDispatch.ok && noDispatch.value.payloadKind === "discover-one") {
    assert.equal(noDispatch.value.dispatch, false);
    assert.equal(noDispatch.value.rangeDays, 90);
  }
  // The US is now an accepted discover-one source with a wider bounded default.
  const us = parseOperatorCanaryEvent({ mode: "discover-one", sourceKey: "us-scotus" });
  assert.equal(us.ok, true);
  if (us.ok && us.value.payloadKind === "discover-one") {
    assert.equal(us.value.sourceKey, "us-scotus");
    assert.equal(us.value.rangeDays, canaryDiscoveryDefaultRangeDays("us-scotus"));
  }
  const cases: Array<[unknown, RegExp]> = [
    [{ mode: "discover-one", sourceKey: "fr-conseil-constitutionnel" }, /discover_one_source_not_allowed/],
    [{ mode: "discover-one", sourceKey: "es-tribunal-constitucional" }, /discover_one_source_not_allowed/],
    [{ mode: "discover-one" }, /discover_one_source_not_allowed/],
    [{ mode: "discover-one", sourceKey: "de-bverfg", candidateUrl: DE_URL }, /unknown_key:candidateUrl/],
    [{ mode: "discover-one", sourceKey: "us-scotus", candidateUrl: US_URL }, /unknown_key:candidateUrl/],
    [{ mode: "discover-one", sourceKey: "de-bverfg", ecli: DE_ECLI }, /unknown_key:ecli/],
    [{ mode: "discover-one", sourceKey: "de-bverfg", rangeDays: 0 }, /discover_one_range_days_invalid/],
    [{ mode: "discover-one", sourceKey: "de-bverfg", rangeDays: 10_000 }, /discover_one_range_days_invalid/],
    [{ mode: "discover-one", sourceKey: "de-bverfg", dispatch: "yes" }, /discover_one_dispatch_invalid/],
  ];
  for (const [payload, pattern] of cases) {
    const result = parseOperatorCanaryEvent(payload);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(payload)}`);
    assert.match(result.ok ? "" : result.error, pattern);
  }
});

test("discover-one: a GENUINE official homepage discovery yields exactly one canary crawl job and a durable provenance edge", async () => {
  const h = createHarness();
  const { fetch: fetcher, seen } = deHomepageFetch({ links: 3 });
  try {
    const handlers = canaryDiscoveryHandlers(h, fetcher);
    const rawBucket = {
      async put(key: string, value: Uint8Array) { await h.reader.put(key, value); },
      async get(key: string) { return h.reader.get(key); },
    };
    const canaryId = "c121c7d71702d52251f439f7130f91be";
    const seeded = await deHomepageMessage(h.ingestDb, rawBucket, canaryId);
    assert.equal(seeded.created, true);
    assert.ok(seeded.payloadRef.startsWith(CANARY_PAYLOAD_PREFIX), "the discover-one artifact lives under the explicit canary prefix");

    // Dispatch + consume the discovery job. The source gate allows the explicit
    // canary payload even though de-bverfg is not a staged source.
    const gate = resolveIngestStageRolloutGate(true, "production", "discovery,crawl,normalize");
    const sent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({
      ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } },
      jobId: seeded.jobId, canaryId, operatorId: "ops", deploymentRef: null, stage: "discovery", now: NOW,
    });
    const discoveryConsume = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.discovery, messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
      gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
      sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: STAGED }),
    });
    assert.equal(discoveryConsume.completed, 1, JSON.stringify(discoveryConsume));
    // It observed real official homepage links, never /SiteGlobals/, never a third party.
    assert.ok(seen.includes(DE_HOMEPAGE), "the official homepage was fetched");
    assert.ok(seen.every((url) => !url.includes("/SiteGlobals/")), "the robots-disallowed search is never queried");
    assert.ok(seen.every((url) => !url.includes("openlegaldata")), "no third-party index is treated as discovery");

    const discoveryJob = await getIngestStageJobById(h.ingestDb, seeded.jobId);
    assert.equal(discoveryJob?.status, "succeeded");
    assert.equal(discoveryJob?.stage, "discovery");
    assert.equal(discoveryJob?.source_key, "de-bverfg");

    // Exactly ONE child crawl job, carrying the same canary source.
    const crawlJobs = h.ingest.prepare("SELECT id,article_id,source_key,payload_ref,status FROM ingest_stage_jobs WHERE stage='crawl'").all() as Array<Record<string, unknown>>;
    assert.equal(crawlJobs.length, 1, "discover-one fans out exactly one crawl job");
    assert.equal(crawlJobs[0].source_key, "de-bverfg");
    assert.ok(String(crawlJobs[0].payload_ref).startsWith(CANARY_PAYLOAD_PREFIX), "the child crawl artifact stays under the canary prefix");

    // The durable provenance edge: discovery -> job_stage_advanced -> child crawl.
    const advance = h.ingest.prepare("SELECT safe_details FROM ingest_stage_job_events WHERE job_id=? AND event_type='job_stage_advanced'").get(seeded.jobId) as { safe_details: string } | undefined;
    assert.ok(advance, "the discovery job emits a durable job_stage_advanced edge");
    const parsedAdvance = JSON.parse(advance!.safe_details) as { nextStage: string; nextKey: string };
    assert.equal(parsedAdvance.nextStage, "crawl");
    const childByKey = h.ingest.prepare("SELECT id FROM ingest_stage_jobs WHERE idempotency_key=?").get(parsedAdvance.nextKey) as { id: string } | undefined;
    assert.equal(childByKey?.id, crawlJobs[0].id, "the advance nextKey resolves to exactly the one child crawl job");
  } finally { h.ingest.close(); h.core.close(); }
});

test("discover-one: the genuine crawl verifies the official ECLI and continues through advance to normalize", async () => {
  const h = createHarness();
  const { fetch: fetcher } = deHomepageFetch({ links: 1, bodyEcli: DE_DISCOVERED_ECLI });
  try {
    const handlers = canaryDiscoveryHandlers(h, fetcher);
    const rawBucket = {
      async put(key: string, value: Uint8Array) { await h.reader.put(key, value); },
      async get(key: string) { return h.reader.get(key); },
    };
    const canaryId = "c121c7d71702d52251f439f7130f91be";
    const seeded = await deHomepageMessage(h.ingestDb, rawBucket, canaryId);
    const gate = resolveIngestStageRolloutGate(true, "production", "discovery,crawl,normalize,translate,public-judgment,publish,search");
    const sourceGate = ({ stage, sourceKey, payloadRef }: { stage: IngestStage; sourceKey: string | null; payloadRef: string | null }) =>
      canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: STAGED });

    const dSent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { dSent.push(body); return {}; } }, jobId: seeded.jobId, canaryId, operatorId: "ops", deploymentRef: null, stage: "discovery", now: NOW });
    await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.discovery, messages: [{ body: dSent[0], ack: () => undefined, retry: () => undefined }] }, { gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300, sourceGate });

    const crawlJob = h.ingest.prepare("SELECT id FROM ingest_stage_jobs WHERE stage='crawl'").get() as { id: string };
    const cSent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { cSent.push(body); return {}; } }, jobId: crawlJob.id, canaryId, operatorId: "ops", deploymentRef: null, stage: "crawl", now: NOW });
    const crawlConsume = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.crawl, messages: [{ body: cSent[0], ack: () => undefined, retry: () => undefined }] }, { gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300, sourceGate });
    assert.equal(crawlConsume.completed, 1, JSON.stringify(crawlConsume));
    assert.equal((await getIngestStageJobById(h.ingestDb, crawlJob.id))?.status, "succeeded");

    // Existing advance mode continues the chain from the succeeded crawl.
    const advanced = await advanceCanaryCase({ ingestDb: h.ingestDb, jobId: crawlJob.id, canaryId, operatorId: "ops", deploymentRef: null, now: NOW });
    assert.equal(advanced.advanced, true, JSON.stringify(advanced));
    assert.equal(advanced.fromStage, "crawl");
    assert.equal(advanced.nextStage, "normalize");
    assert.equal(h.ingest.prepare("SELECT COUNT(*) n FROM ingest_stage_jobs WHERE stage='normalize'").get()?.n, 1);
  } finally { h.ingest.close(); h.core.close(); }
});

test("discover-one US: a GENUINE official slip-opinion listing yields exactly one US canary crawl job, and the crawl verifies the docket", async () => {
  const h = createHarness();
  const listing26 = "https://www.supremecourt.gov/opinions/slipopinion/26";
  const listing25 = "https://www.supremecourt.gov/opinions/slipopinion/25";
  const pdfUrl = "https://www.supremecourt.gov/opinions/25pdf/26a388_q86b.pdf";
  const pdf = scotusPdfFixture("26A388");
  const seen: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\nCrawl-delay: 0", { status: 200, headers: { "content-type": "text/plain" } });
    // The current term 2026 is empty early in October; the previous term 2025
    // carries the newest official opinion (bounded official previous-term scan).
    if (url === listing26) return new Response("<table><tr><th>New term: no opinions yet</th></tr></table>", { status: 200, headers: { "content-type": "text/html" } });
    if (url === listing25) return new Response(`<table><tr><td>Opinion</td><td>9/25/26</td><td>26A388</td><td><a href="/opinions/25pdf/26a388_q86b.pdf">Per Curiam</a></td><td>Revisions: 10/08/26</td></tr></table>`, { status: 200, headers: { "content-type": "text/html" } });
    if (url === pdfUrl) return new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } });
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const handlers = canaryDiscoveryHandlers(h, fetcher);
    const rawBucket = {
      async put(key: string, value: Uint8Array) { await h.reader.put(key, value); },
      async get(key: string) { return h.reader.get(key); },
    };
    const canaryId = "d121c7d71702d52251f439f7130f91be";
    const seeded = await enqueueCanaryDiscovery(h.ingestDb, rawBucket as Parameters<typeof enqueueCanaryDiscovery>[1], {
      sourceKey: "us-scotus", canaryId, operatorId: "ops:reviewer", now: NOW,
    });
    assert.ok(seeded.payloadRef.startsWith(CANARY_PAYLOAD_PREFIX), "the US discover-one artifact lives under the explicit canary prefix");
    const gate = resolveIngestStageRolloutGate(true, "production", "discovery,crawl,normalize");
    const sourceGate = ({ stage, sourceKey, payloadRef }: { stage: IngestStage; sourceKey: string | null; payloadRef: string | null }) =>
      canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: STAGED });

    const dSent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { dSent.push(body); return {}; } }, jobId: seeded.jobId, canaryId, operatorId: "ops", deploymentRef: null, stage: "discovery", now: NOW });
    const discoveryConsume = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.discovery, messages: [{ body: dSent[0], ack: () => undefined, retry: () => undefined }] }, { gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300, sourceGate });
    assert.equal(discoveryConsume.completed, 1, JSON.stringify(discoveryConsume));
    // Genuine official discovery: it fetched the official term listings, never a third party.
    assert.ok(seen.includes(listing26) && seen.includes(listing25), "both official term listings were fetched");
    assert.ok(seen.every((url) => url.startsWith("https://www.supremecourt.gov/")), "no non-official host is queried");

    const crawlJobs = h.ingest.prepare("SELECT id,article_id,source_key,payload_ref FROM ingest_stage_jobs WHERE stage='crawl'").all() as Array<Record<string, unknown>>;
    assert.equal(crawlJobs.length, 1, "US discover-one fans out exactly one crawl job");
    assert.equal(crawlJobs[0].source_key, "us-scotus");

    const cSent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { cSent.push(body); return {}; } }, jobId: String(crawlJobs[0].id), canaryId, operatorId: "ops", deploymentRef: null, stage: "crawl", now: NOW });
    const crawlConsume = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.crawl, messages: [{ body: cSent[0], ack: () => undefined, retry: () => undefined }] }, { gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300, sourceGate });
    assert.equal(crawlConsume.completed, 1, JSON.stringify(crawlConsume));
    assert.equal((await getIngestStageJobById(h.ingestDb, String(crawlJobs[0].id)))?.status, "succeeded");
    // It never publishes.
    assert.equal(h.core.prepare("SELECT COUNT(*) n FROM article_publications_p3").get()?.n, 0, "US discover-one never publishes");
  } finally { h.ingest.close(); h.core.close(); }
});

test("discover-one denials: no candidate fails closed; a managed candidate never fabricates discovery; repeat is idempotent", async () => {
  const cases: Array<{ name: string; setup: (h: Harness) => { fetch: typeof fetch } | null; pattern: RegExp }> = [
    {
      name: "candidate_not_found",
      setup: () => ({ fetch: deHomepageFetch({ homepageHtml: "<html><main>no decision links here</main></html>" }).fetch }),
      pattern: /canary_discovery.candidate_not_found/,
    },
    {
      name: "too_many_links",
      setup: () => ({ fetch: deHomepageFetch({ links: CANARY_DISCOVERY_MAX_LINKS + 2 }).fetch }),
      pattern: /canary_discovery.too_many_links/,
    },
  ];
  for (const { name, setup, pattern } of cases) {
    const h = createHarness();
    try {
      const configured = setup(h)!;
      const handlers = canaryDiscoveryHandlers(h, configured.fetch);
      const rawBucket = {
        async put(key: string, value: Uint8Array) { await h.reader.put(key, value); },
        async get(key: string) { return h.reader.get(key); },
      };
      const canaryId = "c121c7d71702d52251f439f7130f91be";
      const seeded = await deHomepageMessage(h.ingestDb, rawBucket, canaryId);
      const gate = resolveIngestStageRolloutGate(true, "production", "discovery");
      const sent: IngestStageQueueMessage[] = [];
      await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } }, jobId: seeded.jobId, canaryId, operatorId: "ops", deploymentRef: null, stage: "discovery", now: NOW });
      const result = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.discovery, messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
        gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
        sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: STAGED }),
      });
      assert.equal(result.completed, 0, name);
      assert.equal(result.blockedJobs, 1, name);
      const job = await getIngestStageJobById(h.ingestDb, seeded.jobId);
      assert.equal(job?.status, "dead_letter", name);
      assert.match(String(job?.last_error_code), pattern, name);
      assert.equal(h.ingest.prepare("SELECT COUNT(*) n FROM ingest_stage_jobs WHERE stage='crawl'").get()?.n, 0, `${name}: no crawl job is fabricated`);
      assert.equal(h.core.prepare("SELECT COUNT(*) n FROM articles").get()?.n, 0, `${name}: no article is written`);
    } finally { h.ingest.close(); h.core.close(); }
  }

  // A valid canary marker whose request is malformed is dead-lettered, never
  // silently routed to the ordinary fan-out path.
  {
    const h = createHarness();
    const { fetch: fetcher } = deHomepageFetch({ links: 1 });
    try {
      const handlers = canaryDiscoveryHandlers(h, fetcher);
      const rawBucket = {
        async put(key: string, value: Uint8Array) { await h.reader.put(key, value); },
        async get(key: string) { return h.reader.get(key); },
      };
      // A canary artifact with an invalid limit (2) but the marker present.
      const badRef = `${CANARY_PAYLOAD_PREFIX}de-bverfg/bad.json`;
      await rawBucket.put(badRef, new TextEncoder().encode(JSON.stringify({
        sourceKey: "de-bverfg", limit: 2, rangeDays: 60, canaryDiscovery: { canaryId: "a".repeat(32), operatorId: "ops" },
      })));
      const { job } = await registerIngestStageJob(h.ingestDb, {
        stage: "discovery", articleId: "canary-bad", sourceKey: "de-bverfg",
        sourceVersion: "v", contentHash: "h", payloadRef: badRef, now: NOW,
      });
      const gate = resolveIngestStageRolloutGate(true, "production", "discovery");
      const sent: IngestStageQueueMessage[] = [];
      await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } }, jobId: job.id, canaryId: "a".repeat(32), operatorId: "ops", deploymentRef: null, stage: "discovery", now: NOW });
      const result = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.discovery, messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
        gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
        sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: STAGED }),
      });
      assert.equal(result.blockedJobs, 1);
      const row = await getIngestStageJobById(h.ingestDb, job.id);
      assert.equal(row?.status, "dead_letter");
      assert.equal(row?.last_error_code, "ingest_stage.discovery_canary_request_invalid");
    } finally { h.ingest.close(); h.core.close(); }
  }
});

test("discover-one: seeding the same canary twice is idempotent (one discovery job, one child)", async () => {
  const h = createHarness();
  const { fetch: fetcher } = deHomepageFetch({ links: 1 });
  try {
    const handlers = canaryDiscoveryHandlers(h, fetcher);
    const rawBucket = {
      async put(key: string, value: Uint8Array) { await h.reader.put(key, value); },
      async get(key: string) { return h.reader.get(key); },
    };
    const canaryId = "c121c7d71702d52251f439f7130f91be";
    const first = await deHomepageMessage(h.ingestDb, rawBucket, canaryId);
    const second = await deHomepageMessage(h.ingestDb, rawBucket, canaryId);
    assert.equal(first.jobId, second.jobId);
    assert.equal(second.created, false);
    assert.equal(h.ingest.prepare("SELECT COUNT(*) n FROM ingest_stage_jobs WHERE stage='discovery'").get()?.n, 1);

    const gate = resolveIngestStageRolloutGate(true, "production", "discovery,crawl");
    const sent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } }, jobId: first.jobId, canaryId, operatorId: "ops", deploymentRef: null, stage: "discovery", now: NOW });
    await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.discovery, messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
      gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
      sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: STAGED }),
    });
    assert.equal(h.ingest.prepare("SELECT COUNT(*) n FROM ingest_stage_jobs WHERE stage='crawl'").get()?.n, 1);
  } finally { h.ingest.close(); h.core.close(); }
});

test("discover-one denials: the source gate blocks a canary-marked discovery job without the canary prefix", async () => {
  const h = createHarness();
  const { fetch: fetcher } = deHomepageFetch({ links: 1 });
  try {
    const handlers = canaryDiscoveryHandlers(h, fetcher);
    // A discovery job for de-bverfg carrying a valid canary marker but a
    // NON-canary payload ref: the preserved per-source gate must dead-letter it
    // before any handler runs (no network, no child crawl).
    const plainRef = "stages/ingest-discovery-request/de-bverfg/plain.json";
    await h.reader.put(plainRef, new TextEncoder().encode(JSON.stringify({
      sourceKey: "de-bverfg", limit: 1, rangeDays: 60, canaryDiscovery: { canaryId: "a".repeat(32), operatorId: "ops" },
    })));
    const { job } = await registerIngestStageJob(h.ingestDb, {
      stage: "discovery", articleId: "canary-plain", sourceKey: "de-bverfg", sourceVersion: "v", contentHash: "h", payloadRef: plainRef, now: NOW,
    });
    const sent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } }, jobId: job.id, canaryId: "a".repeat(32), operatorId: "ops", deploymentRef: null, stage: "discovery", now: NOW });
    let handlerRan = false;
    const result = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.discovery, messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
      gate: resolveIngestStageRolloutGate(true, "production", "discovery"),
      ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, env: {}, invalidRetryDelaySeconds: 300,
      handlers: { ...handlers, discovery: async (ctx) => { handlerRan = true; return handlers.discovery!(ctx); } },
      sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: STAGED }),
    });
    assert.equal(handlerRan, false, "the handler must never run without the canary prefix");
    assert.equal(result.blockedJobs, 1);
    const row = await getIngestStageJobById(h.ingestDb, job.id);
    assert.equal(row?.status, "dead_letter");
    assert.equal(row?.last_error_code, "ingest_stage.source_not_authorized");
    assert.equal(h.ingest.prepare("SELECT COUNT(*) n FROM ingest_stage_jobs WHERE stage='crawl'").get()?.n, 0);
  } finally { h.ingest.close(); h.core.close(); }
});

test("discover-one denial: an advance with a mismatched canary owner is refused on the discover-one chain", async () => {
  const h = createHarness();
  const { fetch: fetcher } = deHomepageFetch({ links: 1 });
  try {
    const handlers = canaryDiscoveryHandlers(h, fetcher);
    const rawBucket = {
      async put(key: string, value: Uint8Array) { await h.reader.put(key, value); },
      async get(key: string) { return h.reader.get(key); },
    };
    const canaryId = "c121c7d71702d52251f439f7130f91be";
    const seeded = await deHomepageMessage(h.ingestDb, rawBucket, canaryId);
    const gate = resolveIngestStageRolloutGate(true, "production", "discovery,crawl");
    const sourceGate = ({ stage, sourceKey, payloadRef }: { stage: IngestStage; sourceKey: string | null; payloadRef: string | null }) =>
      canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: STAGED });
    const sent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } }, jobId: seeded.jobId, canaryId, operatorId: "ops", deploymentRef: null, stage: "discovery", now: NOW });
    await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.discovery, messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, { gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300, sourceGate });
    // The ownership fence is enforced on the discovered chain too.
    const wrongOwner = await advanceCanaryCase({ ingestDb: h.ingestDb, jobId: seeded.jobId, canaryId: "not-mine", operatorId: "ops", deploymentRef: null, now: NOW });
    assert.equal(wrongOwner.advanced, false);
    assert.equal(wrongOwner.reason, "canary.advance_owner_mismatch");
    // A correct owner+source advance is then permitted (one next job only).
    const ok = await advanceCanaryCase({ ingestDb: h.ingestDb, jobId: seeded.jobId, canaryId, operatorId: "ops", deploymentRef: null, now: NOW });
    assert.equal(ok.advanced, true, JSON.stringify(ok));
    assert.equal(ok.nextStage, "crawl");
    assert.equal(h.ingest.prepare("SELECT COUNT(*) n FROM ingest_stage_jobs WHERE stage='crawl'").get()?.n, 1);
  } finally { h.ingest.close(); h.core.close(); }
});

test("discover-one denial: a homepage advertising only a malicious/external link yields no candidate (never fetched)", async () => {
  const h = createHarness();
  // The homepage advertises only an external-host URL that looks like a decision.
  const { fetch: fetcher, seen } = deHomepageFetch({
    homepageHtml: `<html><main><a href="https://evil.example/SharedDocs/Entscheidungen/DE/2026/09/rk20260923_2bvr168126.html">forged decision</a></main></html>`,
  });
  try {
    const handlers = canaryDiscoveryHandlers(h, fetcher);
    const rawBucket = {
      async put(key: string, value: Uint8Array) { await h.reader.put(key, value); },
      async get(key: string) { return h.reader.get(key); },
    };
    const canaryId = "c121c7d71702d52251f439f7130f91be";
    const seeded = await deHomepageMessage(h.ingestDb, rawBucket, canaryId);
    const gate = resolveIngestStageRolloutGate(true, "production", "discovery");
    const sent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } }, jobId: seeded.jobId, canaryId, operatorId: "ops", deploymentRef: null, stage: "discovery", now: NOW });
    const result = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.discovery, messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
      gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300,
      sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: STAGED }),
    });
    assert.equal(result.blockedJobs, 1);
    const row = await getIngestStageJobById(h.ingestDb, seeded.jobId);
    assert.equal(row?.status, "dead_letter");
    assert.match(String(row?.last_error_code), /canary_discovery.candidate_not_found/);
    assert.ok(seen.every((url) => !url.includes("evil.example")), "a non-official link is never fetched");
    assert.equal(h.ingest.prepare("SELECT COUNT(*) n FROM ingest_stage_jobs WHERE stage='crawl'").get()?.n, 0);
  } finally { h.ingest.close(); h.core.close(); }
});

test("discover-one denial: the discovered official page body carrying a DIFFERENT ECLI fails closed at crawl", async () => {
  const h = createHarness();
  // The homepage discovers rk20260923_2bvr168126 but the fetched detail body
  // carries a different in-body ECLI: the crawl must never persist it.
  const { fetch: fetcher } = deHomepageFetch({ links: 1, bodyEcli: "ECLI:DE:BVerfG:2026:rk20260101.2bvr000001" });
  try {
    const handlers = canaryDiscoveryHandlers(h, fetcher);
    const rawBucket = {
      async put(key: string, value: Uint8Array) { await h.reader.put(key, value); },
      async get(key: string) { return h.reader.get(key); },
    };
    const canaryId = "c121c7d71702d52251f439f7130f91be";
    const seeded = await deHomepageMessage(h.ingestDb, rawBucket, canaryId);
    const gate = resolveIngestStageRolloutGate(true, "production", "discovery,crawl");
    const sourceGate = ({ stage, sourceKey, payloadRef }: { stage: IngestStage; sourceKey: string | null; payloadRef: string | null }) =>
      canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: STAGED });
    const dSent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { dSent.push(body); return {}; } }, jobId: seeded.jobId, canaryId, operatorId: "ops", deploymentRef: null, stage: "discovery", now: NOW });
    await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.discovery, messages: [{ body: dSent[0], ack: () => undefined, retry: () => undefined }] }, { gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300, sourceGate });
    const crawlJob = h.ingest.prepare("SELECT id FROM ingest_stage_jobs WHERE stage='crawl'").get() as { id: string };
    const cSent: IngestStageQueueMessage[] = [];
    await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { cSent.push(body); return {}; } }, jobId: crawlJob.id, canaryId, operatorId: "ops", deploymentRef: null, stage: "crawl", now: NOW });
    const result = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.crawl, messages: [{ body: cSent[0], ack: () => undefined, retry: () => undefined }] }, { gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300, sourceGate });
    assert.equal(result.completed, 0, "a mismatched body is never completed");
    const row = await getIngestStageJobById(h.ingestDb, crawlJob.id);
    assert.notEqual(row?.status, "succeeded");
    assert.equal(h.core.prepare("SELECT COUNT(*) n FROM articles").get()?.n, 0, "a mismatched body is never persisted");
    assert.equal(h.ingest.prepare("SELECT COUNT(*) n FROM ingest_stage_jobs WHERE stage='normalize'").get()?.n, 0, "no downstream job is fabricated");
  } finally { h.ingest.close(); h.core.close(); }
});

test("discover-one SEVEN-STAGE integration: a real discover-one run yields seven actual succeeded stage Job rows for one DE case", async () => {
  const h = createHarness();
  const { fetch: fetcher } = deHomepageFetch({ links: 3, bodyEcli: DE_DISCOVERED_ECLI });
  try {
    const handlers = canaryDiscoveryHandlers(h, fetcher, {
      translation: {
        async summarize(articleId: string) {
          h.core.prepare("UPDATE articles SET status='summarized',translation_status='translated',summary_json=?,korean_title=?,summarized_at=?,updated_at=? WHERE id=?")
            .run(JSON.stringify({ koreanTitle: "요약", summary: { coreSummary: ["핵심"] } }), "요약", NOW, NOW, articleId);
          return { status: "summarized" };
        },
      },
      publication: {
        async publish(articleId: string) {
          h.core.prepare("INSERT INTO article_publications_p3 (id,article_id,state,version_id,revision,decided_by_type,decided_by_id,reason,published_at,withdrawn_at,created_at,updated_at) VALUES (?,?,'published',?,?,?,?,?,?,?,?,?)")
            .run(`pub-${articleId}`, articleId, "version-1", "1", "compatibility", "ingest-stage-publish", "staged publish", NOW, null, NOW, NOW);
          return { published: true, state: "published", versionId: "version-1", publicationRevision: 1 };
        },
      },
      search: {
        async project(articleId: string) {
          const published = h.core.prepare("SELECT state FROM article_publications_p3 WHERE article_id=? AND state='published'").get(articleId);
          return published ? { projected: true, documentCount: 1, ftsCount: 1 } : { projected: false, errorCode: "ingest_stage.search_not_published" };
        },
      },
    });
    const rawBucket = {
      async put(key: string, value: Uint8Array) { await h.reader.put(key, value); },
      async get(key: string) { return h.reader.get(key); },
    };
    const canaryId = "c121c7d71702d52251f439f7130f91be";
    const gate = resolveIngestStageRolloutGate(true, "production", "discovery,crawl,normalize,translate,public-judgment,publish,search");
    const sourceGate = ({ stage, sourceKey, payloadRef }: { stage: IngestStage; sourceKey: string | null; payloadRef: string | null }) =>
      canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: STAGED });
    const stages = ["discovery", "crawl", "normalize", "translate", "public-judgment", "publish", "search"] as const;

    const seeded = await deHomepageMessage(h.ingestDb, rawBucket, canaryId);
    let currentJobId = seeded.jobId;
    for (const stage of stages) {
      const sent: IngestStageQueueMessage[] = [];
      await dispatchCanaryCase({ ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } }, jobId: currentJobId, canaryId, operatorId: "ops", deploymentRef: null, stage, now: NOW });
      assert.equal(sent.length, 1, `${stage}: one message dispatched`);
      const result = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES[stage], messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
        gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers, env: {}, invalidRetryDelaySeconds: 300, sourceGate,
      });
      assert.equal(result.completed, 1, `${stage}: ${JSON.stringify(result)}`);
      const job = await getIngestStageJobById(h.ingestDb, currentJobId);
      assert.equal(job?.status, "succeeded", `${stage} is durably succeeded`);
      if (stage === "search") break;
      const advanced = await advanceCanaryCase({ ingestDb: h.ingestDb, jobId: currentJobId, canaryId, operatorId: "ops", deploymentRef: null, now: NOW });
      assert.equal(advanced.advanced, true, `${stage}->${advanced.nextStage}: ${JSON.stringify(advanced)}`);
      currentJobId = advanced.nextJobId!;
    }

    const rows = h.ingest.prepare("SELECT stage,status,source_key FROM ingest_stage_jobs ORDER BY stage").all() as Array<{ stage: string; status: string; source_key: string }>;
    assert.equal(rows.length, 7, JSON.stringify(rows));
    assert.deepEqual(rows.map((row) => row.stage).sort(), [...stages].sort());
    assert.ok(rows.every((row) => row.status === "succeeded"), JSON.stringify(rows));
    assert.ok(rows.every((row) => row.source_key === "de-bverfg"));

    const core = h.core.prepare("SELECT id,source_metadata FROM articles").get() as { id: string; source_metadata: string };
    const metadata = JSON.parse(core.source_metadata) as { collection: { sourceUrlVerified: boolean }; ecli: string };
    assert.equal(metadata.ecli, DE_DISCOVERED_ECLI);
    assert.equal(metadata.collection.sourceUrlVerified, true);
    assert.equal(h.core.prepare("SELECT state FROM article_publications_p3 WHERE article_id=?").get(core.id)?.state, "published");

    // A real discovery row exists, so the linked seven-stage chain is legitimate;
    // the official-identity gate keeps sevenStageComplete true only because the
    // Core article carries verified official identity (checked above).
    const crawlRow = h.ingest.prepare("SELECT id,article_id FROM ingest_stage_jobs WHERE stage='crawl'").get() as { id: string; article_id: string };
    const realChain = [
      { stage: "discovery", jobId: seeded.jobId, articleId: `canary-discovery:de-bverfg:${canaryId}`, sourceKey: "de-bverfg", status: "succeeded" },
      { stage: "crawl", jobId: crawlRow.id, articleId: crawlRow.article_id, sourceKey: "de-bverfg", status: "succeeded" },
      { stage: "normalize", jobId: "n", articleId: crawlRow.article_id, resultRef: core.id, sourceKey: "de-bverfg", status: "succeeded" },
      { stage: "translate", jobId: "t", articleId: core.id, sourceKey: "de-bverfg", status: "succeeded" },
      { stage: "public-judgment", jobId: "p", articleId: core.id, sourceKey: "de-bverfg", status: "succeeded" },
      { stage: "publish", jobId: "b", articleId: core.id, sourceKey: "de-bverfg", status: "succeeded" },
      { stage: "search", jobId: "s", articleId: core.id, sourceKey: "de-bverfg", status: "succeeded" },
    ];
    const realLineage = applyOfficialIdentityGate(evaluateLinkedLineage(realChain), metadata.collection.sourceUrlVerified === true);
    assert.equal(realLineage.discoveryExecuted, true);
    assert.equal(realLineage.sevenStageComplete, true, JSON.stringify(realLineage));
    // Without the verified official identity, the very same chain must not claim 7/7.
    assert.equal(applyOfficialIdentityGate(evaluateLinkedLineage(realChain), false).sevenStageComplete, false);
  } finally { h.ingest.close(); h.core.close(); }
});

test("audit: applyOfficialIdentityGate only claims a literal 7/7 when the linked chain's official identity is verified", () => {
  const base: ReturnType<typeof evaluateLinkedLineage> = {
    ok: true, reason: null, sourceKey: "de-bverfg", stageCount: 7,
    verifiedStages: ["discovery", "crawl", "normalize", "translate", "public-judgment", "publish", "search"],
    missingStages: [], stagedChainComplete: true, discoveryExecuted: true, sevenStageComplete: true,
    nativeArticleId: "native:abc", coreArticleId: "a60db8bb-4ec3-4ecf-bb5a-6245f621a334", nativeCoreRelation: "resolved",
  };
  assert.equal(applyOfficialIdentityGate(base, true).sevenStageComplete, true);
  const downgraded = applyOfficialIdentityGate(base, false);
  assert.equal(downgraded.sevenStageComplete, false, "an unverified official identity downgrades 7/7");
  assert.equal(downgraded.discoveryExecuted, true, "the stage facts are preserved, only the claim is downgraded");
  assert.equal(downgraded.stagedChainComplete, true);
});

// ---------------------------------------------------------------------------
// bootstrap-de-one: the bounded ORDINARY (non-canary) Germany staged bootstrap.
// It must consult live ownership, seed the SAME ordinary discovery job as the
// scheduled cron (no canary marker, regular payload), and never widen scope.
// ---------------------------------------------------------------------------

const DE_STAGED_PAIRED = {
  stagedAllowlistRaw: "fr-conseil-constitutionnel,es-tribunal-constitucional,de-bverfg",
  m8ExcludeRaw: "fr-conseil-constitutionnel,es-tribunal-constitucional,de-bverfg",
};

test("bootstrap-de-one payload: Germany-only, ordinary shape, rejects candidate/range/US/unknown keys", () => {
  const good = parseOperatorCanaryEvent({ mode: "bootstrap-de-one", sourceKey: "de-bverfg" });
  assert.equal(good.ok, true);
  assert.deepEqual(good.ok ? good.value : null, {
    payloadKind: "bootstrap-de-one", mode: "bootstrap-de-one", sourceKey: "de-bverfg",
    operatorId: "cloudflare-workflow-operator", dispatch: true,
  });
  const noDispatch = parseOperatorCanaryEvent({ mode: "bootstrap-de-one", sourceKey: "de-bverfg", dispatch: false, operatorId: "ops:reviewer" });
  assert.equal(noDispatch.ok, true);
  if (noDispatch.ok && noDispatch.value.payloadKind === "bootstrap-de-one") {
    assert.equal(noDispatch.value.dispatch, false);
    assert.equal(noDispatch.value.operatorId, "ops:reviewer");
  }

  const cases: Array<[unknown, RegExp]> = [
    // US/FR/ES are never accepted; only the exact DE literal.
    [{ mode: "bootstrap-de-one", sourceKey: "us-scotus" }, /bootstrap_de_one_source_not_allowed/],
    [{ mode: "bootstrap-de-one", sourceKey: "fr-conseil-constitutionnel" }, /bootstrap_de_one_source_not_allowed/],
    [{ mode: "bootstrap-de-one" }, /bootstrap_de_one_source_not_allowed/],
    // No candidate URL / ECLI / range can be injected.
    [{ mode: "bootstrap-de-one", sourceKey: "de-bverfg", candidateUrl: DE_URL }, /unknown_key:candidateUrl/],
    [{ mode: "bootstrap-de-one", sourceKey: "de-bverfg", ecli: DE_ECLI }, /unknown_key:ecli/],
    [{ mode: "bootstrap-de-one", sourceKey: "de-bverfg", rangeDays: 60 }, /unknown_key:rangeDays/],
    // dispatch must be boolean when present.
    [{ mode: "bootstrap-de-one", sourceKey: "de-bverfg", dispatch: "yes" }, /bootstrap_de_one_dispatch_invalid/],
    // Unknown top-level keys still rejected.
    [{ mode: "bootstrap-de-one", sourceKey: "de-bverfg", extra: 1 }, /unknown_key:extra/],
  ];
  for (const [payload, pattern] of cases) {
    const result = parseOperatorCanaryEvent(payload);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(payload)}`);
    assert.match(result.ok ? "" : result.error, pattern);
  }
});

test("bootstrap-de-one precondition: only exact-paired DE-staged production discovery is allowed", () => {
  const gateOpen = resolveIngestStageRolloutGate(true, "production", "discovery,crawl,normalize");
  const ok = evaluateBootstrapDeOnePrecondition({
    gate: gateOpen,
    stagedAllowlistRaw: DE_STAGED_PAIRED.stagedAllowlistRaw,
    m8ExcludeRaw: DE_STAGED_PAIRED.m8ExcludeRaw,
    nativeSources: NATIVE_CRAWLER_SOURCES,
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.germanyStaged, true);
  assert.deepEqual(ok.stagedSources, ["fr-conseil-constitutionnel", "es-tribunal-constitucional", "de-bverfg"]);
  assert.deepEqual(ok.effectiveM8Sources, ["us-scotus"]);

  const deny = (
    overrides: Partial<Parameters<typeof evaluateBootstrapDeOnePrecondition>[0]>,
    reason: string,
  ) => {
    const result = evaluateBootstrapDeOnePrecondition({
      gate: gateOpen,
      stagedAllowlistRaw: DE_STAGED_PAIRED.stagedAllowlistRaw,
      m8ExcludeRaw: DE_STAGED_PAIRED.m8ExcludeRaw,
      nativeSources: NATIVE_CRAWLER_SOURCES,
      ...overrides,
    });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.reason, reason);
  };

  // Master switch / environment / stage must all be open.
  deny({ gate: resolveIngestStageRolloutGate(false, "production", "discovery") }, "bootstrap_de_one.stages_disabled");
  deny({ gate: resolveIngestStageRolloutGate(true, "staging", "discovery") }, "bootstrap_de_one.not_production");
  deny({ gate: resolveIngestStageRolloutGate(true, "production", "crawl") }, "bootstrap_de_one.discovery_stage_disabled");
  deny({ gate: resolveIngestStageRolloutGate(true, "production", "") }, "bootstrap_de_one.stage_allowlist_invalid");
  // Empty staged allowlist: nothing to bootstrap.
  deny({ stagedAllowlistRaw: "" }, "bootstrap_de_one.staged_allowlist_empty");
  // Ownership must be exact-paired and DE must be staged-owned.
  deny({ m8ExcludeRaw: "fr-conseil-constitutionnel,es-tribunal-constitucional" }, "bootstrap_de_one.ownership_not_paired_length_mismatch");
  deny({ m8ExcludeRaw: "fr-conseil-constitutionnel,es-tribunal-constitucional,us-scotus" }, "bootstrap_de_one.ownership_not_paired_order_or_content_mismatch");
  deny(
    { stagedAllowlistRaw: "fr-conseil-constitutionnel,es-tribunal-constitucional", m8ExcludeRaw: "fr-conseil-constitutionnel,es-tribunal-constitucional" },
    "bootstrap_de_one.germany_not_staged",
  );
  // US must never be staged through this ordinary mode.
  deny(
    { stagedAllowlistRaw: "fr-conseil-constitutionnel,es-tribunal-constitucional,de-bverfg,us-scotus", m8ExcludeRaw: "fr-conseil-constitutionnel,es-tribunal-constitucional,de-bverfg,us-scotus" },
    "bootstrap_de_one.forbidden_staged_source:us-scotus",
  );
});

test("bootstrap-de-one: seeds the EXACT ordinary discovery job (regular payload ref, no canary marker, idempotent)", async () => {
  const h = createHarness();
  try {
    // The ordinary enqueue path IS what the scheduled cron uses.
    const reader = { async put(key: string, value: Uint8Array) { await h.reader.put(key, value); }, async get(key: string) { return h.reader.get(key); } };
    const seeded = await enqueueIngestStageDiscovery(h.ingestDb, reader as Parameters<typeof enqueueIngestStageDiscovery>[1], {
      sourceKey: BOOTSTRAP_DE_ONE_SOURCE_KEY, limit: 1, now: NOW,
    });
    assert.equal(seeded.created, true);

    const row = h.ingest.prepare("SELECT stage,source_key,article_id,payload_ref,status FROM ingest_stage_jobs").get() as Record<string, unknown>;
    assert.equal(row.stage, "discovery");
    assert.equal(row.source_key, "de-bverfg");
    assert.equal(row.article_id, "native-discovery:de-bverfg:1:default", "ordinary discovery request article id");
    assert.ok(String(row.payload_ref).startsWith("stages/ingest-discovery-request/de-bverfg/"), "regular (non-canary) payload ref");
    assert.ok(!String(row.payload_ref).startsWith(CANARY_PAYLOAD_PREFIX), "no canary prefix");
    assert.equal(row.status, "pending");

    // The stored artifact carries NO canaryDiscovery marker: the discovery handler
    // therefore takes the ordinary fan-out path, not the canary branch.
    const artifact = await reader.get(String(row.payload_ref));
    assert.ok(artifact, "the ordinary discovery request artifact exists");
    const parsed = JSON.parse(new TextDecoder().decode(await artifact!.arrayBuffer())) as Record<string, unknown>;
    assert.equal(parsed.sourceKey, "de-bverfg");
    assert.equal(parsed.limit, 1);
    assert.equal("canaryDiscovery" in parsed, false, "the ordinary payload must not carry a canary marker");
    assert.equal(parseCanaryDiscoveryRequest(parsed).ok, false, "the ordinary payload is not a canary discovery request");

    // Same day replay is idempotent (exactly one ordinary discovery job).
    const replay = await enqueueIngestStageDiscovery(h.ingestDb, reader as Parameters<typeof enqueueIngestStageDiscovery>[1], {
      sourceKey: BOOTSTRAP_DE_ONE_SOURCE_KEY, limit: 1, now: "2026-10-13T06:00:00.000Z",
    });
    assert.equal(replay.jobId, seeded.jobId);
    assert.equal(replay.created, false);
    assert.equal(h.ingest.prepare("SELECT COUNT(*) n FROM ingest_stage_jobs WHERE stage='discovery'").get()?.n, 1);
  } finally { h.ingest.close(); h.core.close(); }
});

test("bootstrap-de-one: strict one-shot dispatch leases ONLY the named ordinary job under the ordinary owner", async () => {
  const h = createHarness();
  try {
    const reader = { async put(key: string, value: Uint8Array) { await h.reader.put(key, value); }, async get(key: string) { return h.reader.get(key); } };
    const seeded = await enqueueIngestStageDiscovery(h.ingestDb, reader as Parameters<typeof enqueueIngestStageDiscovery>[1], {
      sourceKey: BOOTSTRAP_DE_ONE_SOURCE_KEY, limit: 1, now: NOW,
    });
    const sent: IngestStageQueueMessage[] = [];
    const pass = await dispatchIngestStagePass({
      ingestDb: h.ingestDb,
      queue: { async send(body) { sent.push(body); return {}; } },
      stage: "discovery",
      workerId: "bootstrap-de-one:test-instance",
      limit: 1,
      leaseSeconds: 300,
      now: NOW,
      jobId: seeded.jobId,
    });
    assert.equal(pass.enqueued, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].jobId, seeded.jobId);
    const row = await getIngestStageJobById(h.ingestDb, seeded.jobId);
    assert.equal(row?.status, "leased");
    assert.equal(row?.claimed_by, "bootstrap-de-one:test-instance");
    assert.ok(!String(row?.claimed_by).startsWith("canary-owner:"), "the ordinary dispatch must NOT use the canary owner fence");

    // Re-dispatch under the same live lease is a harmless no-op (fence idempotence).
    const again = await dispatchIngestStagePass({
      ingestDb: h.ingestDb,
      queue: { async send(body) { sent.push(body); return {}; } },
      stage: "discovery",
      workerId: "bootstrap-de-one:test-instance",
      limit: 1,
      leaseSeconds: 300,
      now: NOW,
      jobId: seeded.jobId,
    });
    assert.equal(again.enqueued, 0, "an already-leased job is not re-sent");
    assert.equal(sent.length, 1);
  } finally { h.ingest.close(); h.core.close(); }
});

test("bootstrap-de-one: the ordinary discovery job uses the generic fan-out mode, never the protected FR/ES E2E approval", async () => {
  const h = createHarness();
  const { fetch: fetcher } = deHomepageFetch({ links: 3 });
  try {
    const handlers = canaryDiscoveryHandlers(h, fetcher);
    const reader = { async put(key: string, value: Uint8Array) { await h.reader.put(key, value); }, async get(key: string) { return h.reader.get(key); } };
    const seeded = await enqueueIngestStageDiscovery(h.ingestDb, reader as Parameters<typeof enqueueIngestStageDiscovery>[1], {
      sourceKey: BOOTSTRAP_DE_ONE_SOURCE_KEY, limit: 1, now: NOW,
    });
    // Ordinary staged DE ownership: the staged list now includes de-bverfg, so
    // the ordinary (non-canary) payload passes the per-source gate honestly.
    const stagedWithDe = ["fr-conseil-constitutionnel", "es-tribunal-constitucional", "de-bverfg"];
    const gate = resolveIngestStageRolloutGate(true, "production", "discovery,crawl,normalize");
    const sent: IngestStageQueueMessage[] = [];
    await dispatchIngestStagePass({
      ingestDb: h.ingestDb, queue: { async send(body) { sent.push(body); return {}; } },
      stage: "discovery", workerId: "bootstrap-de-one:test", limit: 1, leaseSeconds: 300, now: NOW, jobId: seeded.jobId,
    });
    const result = await consumeIngestStageBatch({ queue: INGEST_STAGE_QUEUES.discovery, messages: [{ body: sent[0], ack: () => undefined, retry: () => undefined }] }, {
      gate, ingestDb: h.ingestDb, coreDb: h.coreDb, now: NOW, handlers: {
        ...handlers,
        // The ordinary discovery stage may fan out; keep only the discovery handler.
        discovery: handlers.discovery!,
      }, env: {}, invalidRetryDelaySeconds: 300,
      sourceGate: ({ stage, sourceKey, payloadRef }) => canarySourceGateAllows({ stage, sourceKey, payloadRef, stagedSources: stagedWithDe }),
    });
    assert.equal(result.completed, 1, JSON.stringify(result));
    const discoveryJob = await getIngestStageJobById(h.ingestDb, seeded.jobId);
    assert.equal(discoveryJob?.status, "succeeded");
    // Generic fan-out registers ordinary `stages/ingest-discovery/...` crawl jobs,
    // NOT canary-prefixed ones and NOT the FR/ES automatic approval path.
    const crawlJobs = h.ingest.prepare("SELECT payload_ref FROM ingest_stage_jobs WHERE stage='crawl'").all() as Array<{ payload_ref: string }>;
    assert.ok(crawlJobs.length >= 1, "the ordinary fan-out produced at least one crawl job");
    assert.ok(crawlJobs.every((job) => job.payload_ref.startsWith("stages/ingest-discovery/")), "crawl artifacts are ordinary, not canary-prefixed");
    assert.ok(crawlJobs.every((job) => !job.payload_ref.startsWith(CANARY_PAYLOAD_PREFIX)));
    // No protected approval ledger row exists (that branch is FR/ES E2E only).
    assert.equal(h.ingest.prepare("SELECT COUNT(*) n FROM ingest_stage_canary_records_v1").get()?.n, 0, "no canary audit row for the ordinary bootstrap");
  } finally { h.ingest.close(); h.core.close(); }
});
