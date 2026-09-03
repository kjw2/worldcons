import assert from "node:assert/strict";
import test from "node:test";
import {
  CASE_CATALOG_FRANCE_HISTORY_FLAG,
  franceConseilExpansionPlan,
  franceConseilScope,
  franceConseilScopeEnabled,
} from "../lib/backfill/france-scope";
import {
  parseFranceConseilDecisionDate,
  parseFranceConseilInventoryPage,
} from "../lib/crawlee/france-conseil-inventory";
import { runCaseBackfillPass, validateNormalizedCase } from "../lib/backfill/service";
import type { CaseBackfillRepository } from "../lib/backfill/repository";
import type {
  CaseBackfillAttemptAuthority,
  CaseBackfillPassInput,
  CaseBackfillSnapshot,
} from "../lib/backfill/types";

const fixture = `<!doctype html><html><body>
  <div data-drupal-facet-id="page_les_decisions_type">
    <a class="is-active" data-drupal-facet-item-count="2">Question prioritaire de constitutionnalité</a>
  </div>
  <div class="view-recherche">
    <a href="/decision/2024/20241115QPC.htm" title="Décision n° 2024-1115 QPC du 13 décembre 2024">QPC</a>
    <a href="/decision/2024/20241091_1092_1093QPC.htm" title="Décision n° 2024-1091/1092/1093 QPC du 28 mai 2024">QPC groupée</a>
    <a href="/decision/2024/20241115QPC.htm" title="duplicate">duplicate</a>
    <a href="/decision/2024/2024873DC.htm" title="Décision n° 2024-873 DC du 12 décembre 2024">DC</a>
    <a href="/actualites/communique/decision-n-2024-1115-qpc">communiqué</a>
  </div>
</body></html>`;

test("France scope is annual, QPC/DC-only, current-year bounded, and disabled by default", () => {
  assert.deepEqual(franceConseilScope(2010, "qpc", 2026), {
    year: 2010, scopeFrom: "2010-01-01", scopeTo: "2010-12-31", documentType: "QPC",
  });
  assert.deepEqual(franceConseilScope(2026, "DC", 2026).documentType, "DC");
  assert.throws(() => franceConseilScope(2009, "QPC", 2026), /france_year_not_supported/);
  assert.throws(() => franceConseilScope(2027, "QPC", 2026), /france_year_not_supported/);
  assert.throws(() => franceConseilScope(2024, "L", 2026), /france_document_type_not_supported/);
  assert.equal(franceConseilScopeEnabled(2024, "QPC", {}, 2026), false);
  assert.equal(franceConseilScopeEnabled(2024, "QPC", { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" }, 2026), true);
  const plan = franceConseilExpansionPlan({}, 2011);
  assert.deepEqual(plan.map((entry) => [entry.year, entry.documentType, entry.enabled]), [
    [2010, "QPC", false], [2010, "DC", false], [2011, "QPC", false], [2011, "DC", false],
  ]);
});

test("France official list parser keeps only the requested decision facet and ignores lastmod-like noise", () => {
  const page = parseFranceConseilInventoryPage(fixture, { year: 2024, documentType: "QPC" });
  assert.equal(page.expectedCount, 2);
  assert.equal(page.hasNextPage, false);
  assert.deepEqual(page.items, [
    {
      stableItemKey: "conseil:20241115qpc",
      sourceRecordId: "20241115QPC",
      discoveredUrl: "https://www.conseil-constitutionnel.fr/decision/2024/20241115QPC.htm",
      documentType: "QPC",
      decisionDateHint: "2024-12-13",
      title: "Décision n° 2024-1115 QPC du 13 décembre 2024",
    },
    {
      stableItemKey: "conseil:20241091_1092_1093qpc",
      sourceRecordId: "20241091_1092_1093QPC",
      discoveredUrl: "https://www.conseil-constitutionnel.fr/decision/2024/20241091_1092_1093QPC.htm",
      documentType: "QPC",
      decisionDateHint: "2024-05-28",
      title: "Décision n° 2024-1091/1092/1093 QPC du 28 mai 2024",
    },
  ]);
});

test("France decision date parser handles accents and premier-day notation without using sitemap lastmod", () => {
  assert.equal(parseFranceConseilDecisionDate("Décision n° 2010-1 QPC du 1er mars 2010"), "2010-03-01");
  assert.equal(parseFranceConseilDecisionDate("Décision n° 2024-1 DC du 31 février 2024"), null);
  assert.equal(parseFranceConseilDecisionDate("lastmod 2024-12-31"), null);
});

const franceSnapshot: CaseBackfillSnapshot = {
  id: "33333333-3333-4333-8333-333333333335",
  sourceKey: "fr-conseil-constitutionnel",
  scopeFrom: "2024-01-01",
  scopeTo: "2024-12-31",
  documentType: "QPC",
  parserVersion: "france-conseil-normalize-v1",
  sourcePolicyVersion: "france-conseil-2026-09-v1",
  status: "open",
};

const authority: CaseBackfillAttemptAuthority = {
  attemptId: "11111111-1111-4111-8111-111111111113",
  runId: "22222222-2222-4222-8222-222222222224",
  fencingToken: "19",
  leaseExpiresAt: "2026-09-03T12:00:00.000Z",
};

function discoveryPass(): CaseBackfillPassInput {
  return {
    cohort: "catalog-backfill",
    snapshotId: franceSnapshot.id,
    phase: "discover",
    passNumber: 1,
    batchLimit: 50,
  };
}

function discoveryRepository(overrides: Partial<CaseBackfillRepository>): CaseBackfillRepository {
  const unavailable = async () => { throw new Error("unused"); };
  return {
    openSnapshot: unavailable,
    upsertInventoryItem: unavailable,
    updateSnapshotEvidence: unavailable,
    closeSnapshot: unavailable,
    getSnapshot: async () => franceSnapshot,
    getSourcePolicy: unavailable,
    getSnapshotStatus: unavailable,
    allocatePass: unavailable,
    beginRun: unavailable,
    finishRun: unavailable,
    countBacklog: unavailable,
    claimItems: unavailable,
    extendItems: unavailable,
    recordFetchArtifact: unavailable,
    getFetchArtifact: unavailable,
    getNormalizationArtifact: unavailable,
    recordNormalizationArtifact: unavailable,
    publishItem: unavailable,
    completeItem: unavailable,
    failItem: unavailable,
    ...overrides,
  } as CaseBackfillRepository;
}

test("France discovery guard rejects execution before creating a run", async () => {
  let began = false;
  const repository = discoveryRepository({
    beginRun: async () => {
      began = true;
      return "55555555-5555-4555-8555-555555555557";
    },
  });
  await assert.rejects(
    runCaseBackfillPass(discoveryPass(), {
      authority, checkpoint: async () => undefined, signal: new AbortController().signal,
    }, {
      repository,
      loadAdapter: async () => null,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      environment: {},
    }),
    /case_backfill\.france_history_disabled/,
  );
  assert.equal(began, false);
});

test("France discovery fixes official count evidence before closing its manifest", async () => {
  const written: string[] = [];
  let evidenceCall: unknown[] = [];
  let closed = false;
  const repository = discoveryRepository({
    beginRun: async () => "55555555-5555-4555-8555-555555555557",
    upsertInventoryItem: async (input) => {
      written.push(input.stableItemKey);
      return "66666666-6666-4666-8666-666666666668";
    },
    updateSnapshotEvidence: async (...args) => { evidenceCall = args; },
    closeSnapshot: async () => {
      closed = true;
      return {
        snapshotId: franceSnapshot.id,
        sourceKey: franceSnapshot.sourceKey,
        snapshotStatus: "closed",
        discoveredTotal: 1,
        terminalTotal: 0,
        processingCompletion: 0,
        expectedCount: 1,
        coverageAssurance: "authoritative_counted",
        corpusCoverage: 1,
        claimed: 0,
        retryWait: 0,
        needsNormalize: 0,
        needsReverify: 0,
        needsRepublish: 0,
        failed: 0,
        currentConformant: 0,
        currentConformance: 0,
        manifestHash: "a".repeat(64),
      };
    },
    finishRun: async () => undefined,
  });
  const result = await runCaseBackfillPass(discoveryPass(), {
      authority, checkpoint: async () => undefined, signal: new AbortController().signal,
    }, {
      repository,
      loadAdapter: async () => null,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      environment: { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" },
      discoverFranceConseilInventory: async (input) => {
        assert.deepEqual([input.year, input.documentType, input.currentYear], [2024, "QPC", 2026]);
        return {
          sourceKey: "fr-conseil-constitutionnel",
          year: 2024,
          documentType: "QPC",
          items: [{
            stableItemKey: "conseil:20241115qpc",
            sourceRecordId: "20241115QPC",
            discoveredUrl: "https://www.conseil-constitutionnel.fr/decision/2024/20241115QPC.htm",
            documentType: "QPC",
            decisionDateHint: "2024-12-13",
            title: "Décision n° 2024-1115 QPC du 13 décembre 2024",
          }],
          pageCount: 1,
          expectedCount: 1,
          coverageEvidence: { method: "official_conseil_annual_type_pagination", expectedCount: 1 },
        };
      },
    });
  assert.deepEqual(written, ["conseil:20241115qpc"]);
  assert.deepEqual(evidenceCall, [
    franceSnapshot.id,
    { method: "official_conseil_annual_type_pagination", expectedCount: 1 },
    1,
    "official_active_type_facet",
  ]);
  assert.equal(closed, true);
  assert.equal(result.succeeded, 1);
});

test("France authority verification binds host, type, date, and official path identity", () => {
  const item = {
    itemId: "44444444-4444-4444-8444-444444444446",
    stableItemKey: "conseil:20241115qpc",
    sourceRecordId: "20241115QPC",
    discoveredUrl: "https://www.conseil-constitutionnel.fr/decision/2024/20241115QPC.htm",
    authorityUrl: null,
    documentType: "QPC",
    decisionDateHint: "2024-12-13",
    resolutionStatus: "normalized",
    currentFetchArtifactId: null,
    currentNormalizationArtifactId: null,
    verifiedNormalizationArtifactId: null,
    publishedNormalizationArtifactId: null,
    itemLeaseExpiresAt: "2026-09-03T12:00:00.000Z",
  };
  const valid = {
    sourceKey: franceSnapshot.sourceKey,
    jurisdiction: "France",
    institutionName: "Conseil constitutionnel",
    contentType: "decision" as const,
    originalUrl: item.discoveredUrl,
    canonicalUrl: item.discoveredUrl,
    originalLanguage: "fr",
    originalTitle: "Décision n° 2024-1115 QPC du 13 décembre 2024",
    originalPublishedAt: "2024-12-13T00:00:00.000Z",
    metadata: { caseNumber: "2024-1115 QPC" },
  };
  assert.deepEqual(validateNormalizedCase(valid, item, franceSnapshot), []);
  assert.deepEqual(validateNormalizedCase({
    ...valid,
    canonicalUrl: "https://qpc360.conseil-constitutionnel.fr/2024-12-13/decision-2024-1115-qpc",
    originalTitle: "Décision n° 2024-873 DC du 12 décembre 2024",
    originalPublishedAt: "2025-01-01T00:00:00.000Z",
  }, item, franceSnapshot), [
    "authority_url_invalid",
    "resolution_type_mismatch",
    "decision_date_after_scope",
    "source_record_id_mismatch",
  ]);
});
