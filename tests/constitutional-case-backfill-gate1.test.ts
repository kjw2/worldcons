import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildBoundedReplayPayload, runCaseBackfillPass, validateNormalizedCase } from "../lib/backfill/service";
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

const migrationPath = path.join(process.cwd(), "supabase/migrations/20260903120000_constitutional_case_backfill_gate1.sql");

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
      reviewDueAt: "2027-09-03T00:00:00.000Z",
    }),
    getSnapshotStatus: unavailable,
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
  assert.deepEqual(completion, {
    nextStatus: "published",
    artifactId: "66666666-6666-4666-8666-666666666666",
  });
  assert.deepEqual(finished, { claimed: 1, succeeded: 1 });
  assert.deepEqual(claimedBatchLimits, [1, 1]);
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
});
