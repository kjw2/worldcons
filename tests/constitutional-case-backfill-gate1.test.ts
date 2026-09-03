import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildBoundedReplayPayload, runCaseBackfillPass, validateNormalizedCase } from "../lib/backfill/service";
import { createCaseBackfillRequestGovernor } from "../lib/backfill/source-request-governor";
import type { CaseBackfillRepository } from "../lib/backfill/repository";
import type {
  CaseBackfillAttemptAuthority,
  CaseBackfillClaimedItem,
  CaseBackfillPassInput,
  CaseBackfillSnapshot,
} from "../lib/backfill/types";
import {
  ADMIN_QUEUE_P1_COMMAND_TYPES,
  resolveAdminQueueP1Authority,
} from "../lib/admin/command-control-plane/p1-authority";
import {
  createAdminP1CommandHandlers,
  type AdminP1HandlerDependencies,
} from "../lib/admin/command-control-plane/p1-handlers";
import { parseSpainTcListPage } from "../lib/crawlee/spain-tribunal-constitucional-spider";
import type { SourceAdapter } from "../lib/sources/types";
import {
  CASE_CATALOG_SPAIN_HISTORY_FLAG,
  spainSentenciaExpansionPlan,
  spainSentenciaYearScope,
} from "../lib/backfill/spain-scope";

const migrationPath = path.join(process.cwd(), "supabase/migrations/20260903120000_constitutional_case_backfill_gate1.sql");
const requestGovernorMigrationPath = path.join(process.cwd(), "supabase/migrations/20260903181000_constitutional_case_source_request_governor.sql");
const inventoryProvenanceMigrationPath = path.join(process.cwd(), "supabase/migrations/20260903182000_constitutional_case_inventory_provenance.sql");
const enumerationArtifactsMigrationPath = path.join(process.cwd(), "supabase/migrations/20260903185000_constitutional_case_enumeration_artifacts.sql");
const crawlerHttpClientPath = path.join(process.cwd(), "lib/crawler/http-client.ts");
const repositoryPath = path.join(process.cwd(), "lib/backfill/repository.ts");

const authority: CaseBackfillAttemptAuthority = {
  attemptId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  fencingToken: "17",
  leaseExpiresAt: "2026-09-03T12:00:00.000Z",
};

const snapshot: CaseBackfillSnapshot = {
  id: "33333333-3333-4333-8333-333333333333",
  sourceKey: "es-tribunal-constitucional",
  scopeFrom: "2024-01-01",
  scopeTo: "2024-12-31",
  documentType: "SENTENCIA",
  parserVersion: "spain-hj-normalize-v1",
  sourcePolicyVersion: "spain-hj-2026-09-v1",
  status: "closed",
};

const claimedItem: CaseBackfillClaimedItem = {
  itemId: "44444444-4444-4444-8444-444444444444",
  stableItemKey: "hj:12345",
  sourceRecordId: "12345",
  discoveredUrl: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/12345",
  authorityUrl: null,
  documentType: "SENTENCIA",
  decisionDateHint: "2024-05-08",
  inventoryMetadata: { inventoryRecord: "hj:12345" },
  resolutionStatus: "fetching",
  currentFetchArtifactId: null,
  currentNormalizationArtifactId: null,
  verifiedNormalizationArtifactId: null,
  publishedNormalizationArtifactId: null,
  itemLeaseExpiresAt: "2026-09-03T12:00:00.000Z",
};

function fakeRepository(overrides: Partial<CaseBackfillRepository> = {}): CaseBackfillRepository {
  const unavailable = async () => { throw new Error("unused"); };
  let itemClaimed = false;
  return {
    openSnapshot: unavailable,
    upsertInventoryItem: unavailable,
    updateSnapshotEvidence: unavailable,
    closeSnapshot: unavailable,
    getSnapshot: async () => snapshot,
    getSourcePolicy: async () => ({
      sourceKey: snapshot.sourceKey,
      policyVersion: snapshot.sourcePolicyVersion,
      normalizeReplayPolicy: "bounded_evidence",
      boundedReplayFields: ["sourceKey", "url", "canonicalUrl", "title", "publishedAt", "contentType", "text", "metadata"],
      minRequestDelayMs: 1000,
      maxConcurrency: 1,
      reviewDueAt: "2027-09-03T00:00:00.000Z",
    }),
    getSnapshotStatus: unavailable,
    acquireSourceRequestPermit: unavailable,
    releaseSourceRequestPermit: unavailable,
    allocatePass: unavailable,
    beginRun: async () => "55555555-5555-4555-8555-555555555555",
    finishRun: async () => undefined,
    countBacklog: async () => 0,
    claimItems: async () => {
      if (itemClaimed) return [];
      itemClaimed = true;
      return [claimedItem];
    },
    extendItems: async (ids) => ids.length,
    recordFetchArtifact: unavailable,
    getFetchArtifact: unavailable,
    getNormalizationArtifact: unavailable,
    recordNormalizationArtifact: unavailable,
    publishItem: unavailable,
    completeItem: async () => undefined,
    failItem: async () => undefined,
    ...overrides,
  } as CaseBackfillRepository;
}

function pass(phase: CaseBackfillPassInput["phase"]): CaseBackfillPassInput {
  return {
    cohort: "catalog-backfill",
    snapshotId: snapshot.id,
    phase,
    passNumber: 1,
    batchLimit: 50,
    parserVersion: "spain-hj-normalize-v1",
    normalizationContractVersion: "case-normalized-v1",
    fetchContractVersion: "spain-hj-fetch-v1",
  };
}

test("Spain inventory parser extracts bare HJ IDs once without fetching detail content", () => {
  const html = `
    <a href="/HJ/es/Resolucion/Show/12345">SENTENCIA 53/2024, de 8 de mayo de 2024</a>
    <a href="/es/Resolucion/Show/12345">duplicate</a>
    <a href="/HJ/es/Resolucion/Show/12346">SENTENCIA 54/2024</a>
    <a href="/HJ/es/Resolucion/Show/0">invalid</a>`;
  assert.deepEqual(parseSpainTcListPage(html), [
    { id: "12345", title: "SENTENCIA 53/2024, de 8 de mayo de 2024" },
    { id: "12346", title: "SENTENCIA 54/2024" },
  ]);
});

test("Spain Gate 5 history uses one immutable annual scope and an explicit expansion flag", () => {
  assert.deepEqual(spainSentenciaYearScope(2020), {
    year: 2020,scopeFrom: "2020-01-01",scopeTo: "2020-12-31",documentType: "SENTENCIA",
  });
  assert.throws(() => spainSentenciaYearScope(2019), /spain_year_not_supported/);
  const disabled = spainSentenciaExpansionPlan({});
  assert.deepEqual(disabled.map((entry) => [entry.year,entry.enabled]), [
    [2020,false],[2021,false],[2022,false],[2023,false],[2024,true],
  ]);
  const enabled = spainSentenciaExpansionPlan({ [CASE_CATALOG_SPAIN_HISTORY_FLAG]: "true" });
  assert.ok(enabled.every((entry) => entry.enabled));
  const cli = fs.readFileSync(path.join(process.cwd(), "scripts/backfill-corpus.ts"), "utf8");
  assert.match(cli, /assertSpainSentenciaYearEnabled/);
  assert.match(cli, /spainSentenciaExpansionPlan/);
});

test("Spain Gate 5 historical discovery is blocked before run creation unless explicitly enabled", async () => {
  const historical = { ...snapshot,scopeFrom: "2020-01-01",scopeTo: "2020-12-31",status: "open" as const };
  let began = false;
  const repository = fakeRepository({
    getSnapshot: async () => historical,
    beginRun: async () => {
      began = true;
      return "55555555-5555-4555-8555-555555555555";
    },
  });
  await assert.rejects(
    runCaseBackfillPass(pass("discover"), {
      authority,checkpoint: async () => undefined,signal: new AbortController().signal,
    }, {
      repository,loadAdapter: async () => null,now: () => new Date("2026-09-03T00:00:00.000Z"),environment: {},
    }),
    /case_backfill\.spain_history_disabled/,
  );
  assert.equal(began, false);
});

test("Spain Gate 5 enabled historical discovery writes and closes only its annual inventory", async () => {
  const historical = { ...snapshot,scopeFrom: "2020-01-01",scopeTo: "2020-12-31",status: "open" as const };
  const written: Array<{ stableItemKey: string; decisionDateHint?: string | null }> = [];
  let evidence: Record<string, unknown> | null = null;
  let closed = false;
  let finished = false;
  const repository = fakeRepository({
    getSnapshot: async () => historical,
    beginRun: async () => "55555555-5555-4555-8555-555555555555",
    upsertInventoryItem: async (input) => {
      written.push(input);
      return "66666666-6666-4666-8666-666666666666";
    },
    updateSnapshotEvidence: async (_id, value) => { evidence = value; },
    closeSnapshot: async () => {
      closed = true;
      return {
        snapshotId: historical.id,sourceKey: historical.sourceKey,snapshotStatus: "closed",
        discoveredTotal: 1,terminalTotal: 0,processingCompletion: 0,expectedCount: null,
        coverageAssurance: "authoritative_enumerated",corpusCoverage: null,claimed: 0,retryWait: 0,
        needsNormalize: 0,needsReverify: 0,needsRepublish: 0,failed: 0,currentConformant: 0,
        currentConformance: 0,manifestHash: "a".repeat(64),
      };
    },
    finishRun: async (input) => { finished = input.status === "succeeded"; },
  });
  const result = await runCaseBackfillPass(pass("discover"), {
    authority,checkpoint: async () => undefined,signal: new AbortController().signal,
  }, {
    repository,
    loadAdapter: async () => null,
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    environment: { [CASE_CATALOG_SPAIN_HISTORY_FLAG]: "true" },
    discoverSpainTcInventory: async (input) => {
      assert.equal(input.year, 2020);
      return {
        sourceKey: "es-tribunal-constitucional",
        year: 2020,
        documentType: "SENTENCIA",
        items: [{
          stableItemKey: "hj:202001",sourceRecordId: "202001",
          discoveredUrl: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/202001",
          documentType: "SENTENCIA",decisionDateHint: "2020-02-03",title: "SENTENCIA 1/2020",
        }],
        pageCount: 1,
        coverageEvidence: {
          method: "official_hj_search_pagination",scopeFrom: "2020-01-01",scopeTo: "2020-12-31",
          exhausted: true,discoveredCount: 1,
        },
      };
    },
  });
  assert.deepEqual(written.map((item) => [item.stableItemKey,item.decisionDateHint]), [["hj:202001","2020-02-03"]]);
  assert.deepEqual(evidence, {
    method: "official_hj_search_pagination",scopeFrom: "2020-01-01",scopeTo: "2020-12-31",
    exhausted: true,discoveredCount: 1,
  });
  assert.equal(closed, true);
  assert.equal(finished, true);
  assert.deepEqual(result, {
    phase: "discover",snapshotId: snapshot.id,passNumber: 1,claimed: 1,succeeded: 1,
    retryableFailed: 0,terminalFailed: 0,backlogRemaining: false,
  });
});

test("bounded replay projection retains only reviewed fields and remains independently normalizable", () => {
  const payload = buildBoundedReplayPayload({
    sourceKey: "es-tribunal-constitucional",
    url: claimedItem.discoveredUrl,
    canonicalUrl: claimedItem.discoveredUrl,
    title: "SENTENCIA 53/2024",
    contentType: "decision",
    text: "official text",
    metadata: { resolutionType: "SENTENCIA", internalDiagnostic: "do-not-copy" },
    html: "<secretly-large-html />",
  }, ["sourceKey", "url", "canonicalUrl", "title", "contentType", "text", "metadata.resolutionType"]);
  assert.equal(payload.sourceKey, "es-tribunal-constitucional");
  assert.equal((payload.metadata as Record<string, unknown>).resolutionType, "SENTENCIA");
  assert.equal("html" in payload, false);
  assert.equal("internalDiagnostic" in (payload.metadata as Record<string, unknown>), false);
});

test("authority verification is fail-closed for source, type, date, and HJ identity drift", () => {
  const valid = {
    sourceKey: snapshot.sourceKey,
    jurisdiction: "Spain",
    institutionName: "Tribunal Constitucional de España",
    contentType: "decision" as const,
    originalUrl: claimedItem.discoveredUrl,
    canonicalUrl: claimedItem.discoveredUrl,
    originalLanguage: "es",
    originalTitle: "SENTENCIA 53/2024",
    originalPublishedAt: "2024-05-08T00:00:00.000Z",
    metadata: { resolutionType: "SENTENCIA", decisionDate: "2024-05-08" },
  };
  assert.deepEqual(validateNormalizedCase(valid, claimedItem, snapshot), []);
  assert.deepEqual(validateNormalizedCase({
    ...valid,
    canonicalUrl: "https://attacker.example/HJ/es/Resolucion/Show/99999",
    metadata: { resolutionType: "AUTO", decisionDate: "2025-01-01" },
  }, claimedItem, snapshot), [
    "authority_url_invalid",
    "resolution_type_mismatch",
    "decision_date_after_scope",
    "source_record_id_mismatch",
  ]);
});

test("distributed request governor waits for a database permit, normalizes the origin, and releases once", async () => {
  const waits: number[] = [];
  const origins: string[] = [];
  let acquireCount = 0;
  let releaseCount = 0;
  const repository = fakeRepository({
    acquireSourceRequestPermit: async (input) => {
      origins.push(input.requestOrigin);
      acquireCount += 1;
      return acquireCount === 1
        ? { granted: false, permitId: null, retryAfterMs: 125, permitLeaseExpiresAt: null }
        : {
          granted: true,
          permitId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          retryAfterMs: 0,
          permitLeaseExpiresAt: "2026-09-03T12:00:00.000Z",
        };
    },
    releaseSourceRequestPermit: async () => { releaseCount += 1; },
  });
  const governor = createCaseBackfillRequestGovernor({
    repository,
    snapshotId: snapshot.id,
    phase: "fetch",
    authority,
    checkpoint: async () => undefined,
    signal: new AbortController().signal,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  const permit = await governor.acquire(`${claimedItem.discoveredUrl}?ignored=1`);
  await permit.release();
  await permit.release();
  assert.deepEqual(waits, [125]);
  assert.deepEqual(origins, ["https://hj.tribunalconstitucional.es", "https://hj.tribunalconstitucional.es"]);
  assert.equal(releaseCount, 1);
  await assert.rejects(governor.acquire("http://hj.tribunalconstitucional.es/insecure"), /request_https_required/);
});

test("fetch pass records a bounded artifact and preserves a published terminal outcome during maintenance", async () => {
  let artifactPayload: Record<string, unknown> = {};
  let completion: { nextStatus: string; artifactId: unknown } | null = null;
  let finished: { claimed: number; succeeded: number } | null = null;
  const claimedBatchLimits: number[] = [];
  let served = false;
  const item = { ...claimedItem, resolutionStatus: "published" };
  const repository = fakeRepository({
    claimItems: async (input) => {
      claimedBatchLimits.push(input.batchLimit);
      if (served) return [];
      served = true;
      return [item];
    },
    recordFetchArtifact: async (input) => {
      assert(input.boundedReplayPayload);
      artifactPayload = input.boundedReplayPayload;
      assert.equal(input.payloadHash.length, 64);
      assert.equal(input.replayability, "bounded_evidence");
      return "66666666-6666-4666-8666-666666666666";
    },
    completeItem: async (input) => {
      completion = { nextStatus: input.nextStatus, artifactId: input.resultMetadata.artifactId };
    },
    finishRun: async (input) => { finished = { claimed: input.claimed, succeeded: input.succeeded }; },
  });
  const adapter: SourceAdapter = {
    sourceKey: snapshot.sourceKey,
    displayName: "Spain",
    jurisdiction: "Spain",
    baseUrl: "https://hj.tribunalconstitucional.es",
    defaultLanguage: "es",
    discover: async () => [],
    fetchItem: async () => ({
      sourceKey: snapshot.sourceKey,
      url: claimedItem.discoveredUrl,
      canonicalUrl: claimedItem.discoveredUrl,
      title: "SENTENCIA 53/2024",
      publishedAt: "2024-05-08T00:00:00.000Z",
      contentType: "decision",
      text: "official text",
      metadata: { resolutionType: "SENTENCIA", internalDiagnostic: "excluded-by-policy-projection" },
    }),
    normalize: async () => { throw new Error("unused"); },
  };
  const result = await runCaseBackfillPass(pass("fetch"), {
    authority,
    checkpoint: async () => undefined,
    signal: new AbortController().signal,
  }, { repository, loadAdapter: async () => adapter, now: () => new Date("2026-09-03T00:00:00.000Z") });
  assert.equal(result.succeeded, 1);
  assert.equal((artifactPayload.metadata as Record<string, unknown>).resolutionType, "SENTENCIA");
  assert.deepEqual((artifactPayload.metadata as Record<string, unknown>).sourceInventory, claimedItem.inventoryMetadata);
  assert.deepEqual(completion, {
    nextStatus: "published",
    artifactId: "66666666-6666-4666-8666-666666666666",
  });
  assert.deepEqual(finished, { claimed: 1, succeeded: 1 });
  assert.deepEqual(claimedBatchLimits, [1, 1]);
});

test("normalize pass carries immutable inventory provenance into the publication artifact", async () => {
  const fetchArtifactId = "66666666-6666-4666-8666-666666666667";
  const item = { ...claimedItem, resolutionStatus: "fetched", currentFetchArtifactId: fetchArtifactId };
  let recordedOutput: Record<string, unknown> | null = null;
  let served = false;
  const repository = fakeRepository({
    claimItems: async () => {
      if (served) return [];
      served = true;
      return [item];
    },
    getFetchArtifact: async () => ({
      id: fetchArtifactId,
      itemId: item.itemId,
      sourcePolicyVersion: snapshot.sourcePolicyVersion,
      authorityUrl: item.discoveredUrl,
      payloadHash: "a".repeat(64),
      replayability: "bounded_evidence",
      immutableStorageRef: null,
      boundedReplayPayload: {
        sourceKey: snapshot.sourceKey,
        url: item.discoveredUrl,
        canonicalUrl: item.discoveredUrl,
        contentType: "decision",
        text: "official text",
      },
      fetchContractVersion: "spain-hj-fetch-v1",
    }),
    recordNormalizationArtifact: async (input) => {
      recordedOutput = input.normalizedOutput;
      return "77777777-7777-4777-8777-777777777778";
    },
  });
  const adapter: SourceAdapter = {
    sourceKey: snapshot.sourceKey,
    displayName: "Spain",
    jurisdiction: "Spain",
    baseUrl: "https://hj.tribunalconstitucional.es",
    defaultLanguage: "es",
    discover: async () => [],
    fetchItem: async () => { throw new Error("unused"); },
    normalize: async (raw) => ({
      sourceKey: raw.sourceKey,
      jurisdiction: "Spain",
      institutionName: "Tribunal Constitucional de España",
      contentType: "decision",
      originalUrl: raw.url,
      canonicalUrl: raw.canonicalUrl,
      originalLanguage: "es",
      originalTitle: "SENTENCIA 53/2024",
      metadata: { adapterField: "kept" },
    }),
  };
  const result = await runCaseBackfillPass(pass("normalize"), {
    authority,
    checkpoint: async () => undefined,
    signal: new AbortController().signal,
  }, { repository, loadAdapter: async () => adapter, now: () => new Date("2026-09-03T00:00:00.000Z") });
  assert.equal(result.succeeded, 1);
  const output = recordedOutput as Record<string, unknown> | null;
  assert(output);
  const metadata = (output.metadata ?? {}) as Record<string, unknown>;
  assert.equal(metadata.adapterField, "kept");
  assert.deepEqual(metadata.sourceInventory, claimedItem.inventoryMetadata);
});

test("P1 authority and handler carry the exact attempt fence into a bounded backfill pass", async () => {
  const resolved = resolveAdminQueueP1Authority({
    ADMIN_QUEUE_V3_WORKER_ENABLED: "true",
    ADMIN_QUEUE_V3_WORKER_COMMAND_TYPES: "p1.case-backfill.normalize",
    ADMIN_QUEUE_V3_WORKER_COHORTS: "catalog-backfill",
  });
  assert.equal(resolved.enabled, true);
  assert(ADMIN_QUEUE_P1_COMMAND_TYPES.includes("p1.case-backfill.normalize"));

  let observed: { phase: string; authority: CaseBackfillAttemptAuthority } | null = null;
  const dependencies = {
    runCaseBackfillPass: async (input: CaseBackfillPassInput, context: { authority: CaseBackfillAttemptAuthority }) => {
      observed = { phase: input.phase, authority: context.authority };
      return { ...input, claimed: 0, succeeded: 0, retryableFailed: 0, terminalFailed: 0, backlogRemaining: false };
    },
  } as unknown as AdminP1HandlerDependencies;
  const handler = createAdminP1CommandHandlers(dependencies)["p1.case-backfill.normalize"];
  await handler({
    cohort: "catalog-backfill",
    snapshotId: snapshot.id,
    passNumber: 1,
    batchLimit: 25,
  }, {
    authority,
    checkpoint: async () => undefined,
    signal: new AbortController().signal,
  });
  assert.deepEqual(observed, { phase: "normalize", authority });
});

test("invalid snapshot phases and disabled Catalog writes never create a running backfill run", async () => {
  for (const [input, status, expected] of [
    [pass("fetch"), "open", /snapshot_not_closed/],
    [pass("publish"), "closed", /catalog_write_disabled/],
  ] as const) {
    let began = false;
    const repository = fakeRepository({
      getSnapshot: async () => ({ ...snapshot, status }),
      beginRun: async () => {
        began = true;
        return "55555555-5555-4555-8555-555555555555";
      },
    });
    await assert.rejects(
      runCaseBackfillPass(input, {
        authority,
        checkpoint: async () => undefined,
        signal: new AbortController().signal,
      }, {
        repository,
        loadAdapter: async () => null,
        now: () => new Date("2026-09-03T00:00:00.000Z"),
        environment: {},
      }),
      expected,
    );
    assert.equal(began, false);
  }
});

test("enabled publish pass delegates the fenced item to the atomic Catalog publisher", async () => {
  let published: { itemId: string; authority: CaseBackfillAttemptAuthority } | null = null;
  const item = {
    ...claimedItem,
    resolutionStatus: "verified",
    verifiedNormalizationArtifactId: "77777777-7777-4777-8777-777777777777",
  };
  let served = false;
  const repository = fakeRepository({
    claimItems: async () => {
      if (served) return [];
      served = true;
      return [item];
    },
    publishItem: async (input) => {
      published = { itemId: input.itemId, authority: input.authority };
      return {
        articleId: "88888888-8888-4888-8888-888888888888",
        versionId: "99999999-9999-4999-8999-999999999999",
        versionRevision: 1,
        publicationRevision: 1,
        articleSlug: "es-tc-12345",
      };
    },
  });
  const result = await runCaseBackfillPass(pass("publish"), {
    authority,
    checkpoint: async () => undefined,
    signal: new AbortController().signal,
  }, {
    repository,
    loadAdapter: async () => ({
      sourceKey: snapshot.sourceKey,
      displayName: "Spain",
      jurisdiction: "Spain",
      baseUrl: "https://hj.tribunalconstitucional.es",
      defaultLanguage: "es",
      discover: async () => [],
      fetchItem: async () => { throw new Error("unused"); },
      normalize: async () => { throw new Error("unused"); },
    }),
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    environment: { CASE_CATALOG_WRITE_ENABLED: "true" },
  });
  assert.equal(result.succeeded, 1);
  assert.deepEqual(published, { itemId: item.itemId, authority });
});

test("Gate 1 migration fixes manifest, lease, artifact, and maintenance invariants in the database", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const requestGovernorSql = fs.readFileSync(requestGovernorMigrationPath, "utf8");
  const inventoryProvenanceSql = fs.readFileSync(inventoryProvenanceMigrationPath, "utf8");
  const enumerationArtifactsSql = fs.readFileSync(enumerationArtifactsMigrationPath, "utf8");
  const crawlerHttpClient = fs.readFileSync(crawlerHttpClientPath, "utf8");
  const repository = fs.readFileSync(repositoryPath, "utf8");
  for (const table of [
    "source_corpus_policies",
    "source_inventory_snapshots",
    "source_backfill_runs",
    "source_backfill_items",
    "source_fetch_artifacts",
    "source_normalization_artifacts",
    "source_backfill_item_events",
  ]) {
    assert.match(sql, new RegExp(`alter table ${table} enable row level security`, "i"));
  }
  assert.match(sql, /CASE_BACKFILL_MANIFEST_CLOSED/);
  assert.match(sql, /CASE_BACKFILL_STALE_FENCE/);
  assert.match(sql, /least\(v_attempt_lease, now\(\) \+ make_interval/);
  assert.match(sql, /CASE_BACKFILL_ACTIVE_ITEM_CLAIMS/);
  assert.match(sql, /CASE_BACKFILL_ACTIVE_RUN/);
  assert.match(sql, /CASE_BACKFILL_RUN_FENCE_LOST/);
  assert.match(sql, /CASE_BACKFILL_RUN_NOT_ACTIVE/);
  assert.match(sql, /CASE_BACKFILL_PASS_SCOPE_MISMATCH/);
  assert.match(sql, /p_batch_limit > coalesce\(\(v_command_payload->>'batchLimit'\)::integer, 50\)/);
  assert.match(sql, /SOURCE_POLICY_REVIEW_OVERDUE/);
  assert.match(sql, /before update or delete on source_fetch_artifacts/);
  assert.match(sql, /before update or delete on source_normalization_artifacts/);
  assert.match(sql, /review_due_at > reviewed_at/);
  assert.match(sql, /status = case when p_phase = 'fetch' and i\.status <> 'published' then 'fetching' else i\.status end/);
  assert.match(sql, /verified_normalization_artifact_id is distinct from i\.published_normalization_artifact_id/);
  assert.match(sql, /p_target_version/);
  assert.doesNotMatch(sql, /grant\s+(?:select|insert|update|delete|all)[^;]+\s+to\s+(?:anon|authenticated)/i);
  assert.doesNotMatch(sql, /cloudflare|workers\.dev|d1\b/i);
  assert.match(requestGovernorSql, /source_backfill_request_permit_acquire_v1/);
  assert.match(requestGovernorSql, /pg_advisory_xact_lock/);
  assert.match(requestGovernorSql, /v_policy\.min_request_delay_ms/);
  assert.match(requestGovernorSql, /v_effective_limit/);
  assert.match(requestGovernorSql, /CASE_BACKFILL_REQUEST_HOST_NOT_ALLOWED/);
  assert.match(requestGovernorSql, /least\(\s*v_attempt_lease/);
  assert.match(requestGovernorSql, /source_backfill_release_request_permits_on_attempt_terminal_v1\(\)[\s\S]*security definer/i);
  assert.doesNotMatch(requestGovernorSql, /grant\s+(?:select|insert|update|delete|all)[^;]+\s+to\s+(?:anon|authenticated)/i);
  assert.match(crawlerHttpClient, /governedBufferedFetch\(request\.url/);
  assert.match(crawlerHttpClient, /}, request\);/);
  assert.match(inventoryProvenanceSql, /inventory_metadata jsonb not null default/);
  assert.match(inventoryProvenanceSql, /new\.inventory_metadata is distinct from old\.inventory_metadata/);
  assert.match(inventoryProvenanceSql, /i\.discovered_decision_date_hint, i\.inventory_metadata/);
  assert.match(inventoryProvenanceSql, /CASE_BACKFILL_FRANCE_DILA_PROVENANCE_INVALID/);
  assert.match(inventoryProvenanceSql, /case_backfill_inventory_json_has_secret_v1/);
  assert.match(inventoryProvenanceSql, /revoke execute on function source_inventory_item_upsert_v1[\s\S]*from service_role/);
  assert.match(inventoryProvenanceSql, /revoke execute on function source_inventory_snapshot_close_v1[\s\S]*from service_role/);
  assert.match(inventoryProvenanceSql, /revoke execute on function source_backfill_items_claim_v1[\s\S]*from service_role/);
  assert.doesNotMatch(inventoryProvenanceSql, /grant execute on function source_inventory_item_upsert_v1[\s\S]*to service_role/);
  assert.match(enumerationArtifactsSql, /create table if not exists source_inventory_enumeration_artifacts/);
  assert.match(enumerationArtifactsSql, /CASE_BACKFILL_ENUMERATION_ARTIFACT_IMMUTABLE/);
  assert.match(enumerationArtifactsSql, /CASE_BACKFILL_ENUMERATION_EVIDENCE_REQUIRED/);
  assert.match(enumerationArtifactsSql, /enumeration_manifest_hash/);
  assert.doesNotMatch(enumerationArtifactsSql, /grant\s+(?:select|insert|update|delete|all)[^;]+\s+to\s+(?:anon|authenticated)/i);
  assert.match(repository, /rpc\("source_inventory_item_upsert_v2"/);
  assert.match(repository, /rpc\("source_inventory_enumeration_artifact_record_v1"/);
  assert.match(repository, /rpc\("source_inventory_snapshot_close_v3"/);
  assert.match(repository, /rpc\("source_backfill_items_claim_v2"/);
});
