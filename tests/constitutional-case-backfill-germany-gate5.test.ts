import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGermanyBverfgYearEnabled,
  CASE_CATALOG_GERMANY_HISTORY_FLAG,
  GERMANY_BVERFG_HISTORY_START_YEAR,
  germanyBverfgExpansionPlan,
  germanyBverfgYearEnabled,
  germanyBverfgYearScope,
} from "../lib/backfill/germany-scope";
import {
  discoverBverfgInventory,
  parseBverfgDejureInventoryPage,
} from "../lib/crawlee/bverfg-inventory";
import { loadCaseBackfillSourceStrategy } from "../lib/backfill/source-strategies";
import { runCaseBackfillPass } from "../lib/backfill/service";
import {
  validateBverfgInventoryResult,
  verifyBverfgInventoryReadOnly,
} from "../lib/backfill/germany-inventory-verification";
import { verifyBverfgPrivateShadowReadiness } from "../lib/backfill/germany-shadow-readiness";
import type {
  BverfgShadowPolicyEvidence,
  BverfgShadowReadinessRepository,
} from "../lib/backfill/germany-shadow-readiness-repository";
import type { CaseBackfillRepository } from "../lib/backfill/repository";
import type {
  CaseBackfillAttemptAuthority,
  CaseBackfillClaimedItem,
  CaseBackfillPassInput,
  CaseBackfillSnapshot,
} from "../lib/backfill/types";
import type { NormalizedArticle } from "../lib/sources/types";
import { bverfgOfficialUrlCandidatesForItem } from "../lib/sources/bundesverfassungsgericht";

interface FixtureRow {
  date: string;
  docket: string;
  title?: string;
}

function dejurePage(rows: FixtureRow[], pages: number[], popular?: FixtureRow) {
  const popularHtml = popular
    ? `<a href="/popular">BVerfG, ${popular.date} - ${popular.docket}</a>`
    : "";
  const rowHtml = rows.map((row) => {
    const href = `/dienste/vernetzung/rechtsprechung?Gericht=BVerfG&Datum=${row.date}&Aktenzeichen=${encodeURIComponent(row.docket)}`;
    return `<li><a data-djo_karte="+|-|-|-" href="${href}" title="${row.title ?? ""}">BVerfG, ${row.date} - ${row.docket}</a></li>`;
  }).join("");
  const pagination = pages.map((page) => (
    `<a href="/dienste/rechtsprechung?gericht=BVerfG&amp;seite=${page}">${page}</a>`
  )).join("");
  return `<html><body>${popularHtml}<ol>${rowHtml}</ol><nav>${pagination}</nav></body></html>`;
}

test("Germany BVerfG scope is annual, 1998-bounded, and disabled by default", () => {
  assert.equal(GERMANY_BVERFG_HISTORY_START_YEAR, 1998);
  assert.deepEqual(germanyBverfgYearScope(2024, 2026), {
    year: 2024,
    scopeFrom: "2024-01-01",
    scopeTo: "2024-12-31",
    documentType: "DECISION",
  });
  assert.throws(() => germanyBverfgYearScope(1997, 2026), /germany_year_not_supported/);
  assert.throws(() => germanyBverfgYearScope(2027, 2026), /germany_year_not_supported/);
  assert.equal(germanyBverfgYearEnabled(2024, {}, 2026), false);
  assert.equal(germanyBverfgYearEnabled(2024, { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" }, 2026), true);
  assert.throws(() => assertGermanyBverfgYearEnabled(2024, {}, 2026), /germany_history_disabled/);
  const plan = germanyBverfgExpansionPlan({}, 2026);
  assert.equal(plan[0].year, 2026);
  assert.equal(plan.at(-1)?.year, 1998);
  assert.equal(plan.every((entry) => !entry.enabled), true);
});

test("dejure parser ignores popular links and keeps same-docket decisions on different dates", () => {
  const parsed = parseBverfgDejureInventoryPage(dejurePage([
    { date: "15.04.2021", docket: "2 BvR 547/21", title: "Zweiter Beschluss" },
    { date: "26.03.2021", docket: "2 BvR 547/21", title: "Erster Beschluss" },
    { date: "01.03.2021", docket: "3 Unknown 1/21", title: "Unresolved" },
  ], [2, 426], { date: "17.12.1953", docket: "1 BvR 147/52" }), 1);

  assert.equal(parsed.items.length, 3);
  assert.equal(parsed.items[0].decisionDateHint, "2021-04-15");
  assert.notEqual(parsed.items[0].stableItemKey, parsed.items[1].stableItemKey);
  assert.equal(parsed.items[0].sourceRecordId, null);
  assert.equal(parsed.items[0].inventoryMetadata.sourceUrlVerified, false);
  assert.equal(parsed.items[0].inventoryMetadata.authorityVerificationRequired, true);
  assert.deepEqual(
    (parsed.items[0].inventoryMetadata.officialUrlCandidates as string[]).map((url) => url.split("/").at(-1)),
    ["rk20210415_2bvr054721.html", "rs20210415_2bvr054721.html"],
  );
  assert.equal(parsed.items[2].discoveredUrl, "https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html");
  assert.equal(parsed.observedLastPage, 426);
  assert.equal(parsed.hasNextPage, true);
  assert.match(parsed.listingFingerprint, /^[0-9a-f]{64}$/);
});

test("external-index inventory crosses the annual boundary and verifies a stable first-page probe", async () => {
  const fixtures = new Map<number, string>([
    [1, dejurePage([
      { date: "10.01.2025", docket: "1 BvR 10/25" },
      { date: "31.12.2024", docket: "1 BvR 20/24" },
    ], [2, 3])],
    [2, dejurePage([
      { date: "31.12.2024", docket: "1 BvR 20/24" },
      { date: "02.01.2024", docket: "2 BvR 547/21" },
    ], [1, 3])],
    [3, dejurePage([
      { date: "31.12.2023", docket: "1 BvR 30/23" },
    ], [1, 2])],
  ]);
  const calls: number[] = [];
  const inventory = await discoverBverfgInventory({
    year: 2024,
    currentYear: 2026,
    maxPages: 3,
    fetchPage: async (_url, page) => {
      calls.push(page);
      const fixture = fixtures.get(page);
      if (!fixture) throw new Error("unexpected page");
      return fixture;
    },
  });

  assert.deepEqual(calls, [1, 2, 3, 1]);
  assert.equal(inventory.pageCount, 3);
  assert.equal(inventory.requestCount, 4);
  assert.equal(inventory.items.length, 2);
  assert.equal(inventory.expectedCount, null);
  assert.equal(inventory.expectedCountBasis, null);
  assert.equal(inventory.enumerationArtifacts.length, 4);
  assert.deepEqual(
    inventory.enumerationArtifacts.map((artifact) => [artifact.artifactKind, artifact.sequenceNumber]),
    [["page", 1], ["page", 2], ["page", 3], ["boundary_probe", 1]],
  );
  assert.equal(inventory.enumerationArtifacts.every((artifact) => (
    /^[0-9a-f]{64}$/.test(artifact.responseHash)
    && /^[0-9a-f]{64}$/.test(artifact.recordManifestHash)
    && artifact.safeDetails.storesExternalText === false
  )), true);
  assert.equal(inventory.coverageEvidence.coverageAssurance, "external_index_assisted");
  assert.equal(inventory.coverageEvidence.officialCorpusCoverageClaimed, false);
  assert.equal(inventory.coverageEvidence.crossedOlderBoundary, true);
  assert.equal(inventory.coverageEvidence.firstPageProbeStable, true);
});

test("external-index inventory fails closed when the listing changes during pagination", async () => {
  let firstPageReads = 0;
  await assert.rejects(
    discoverBverfgInventory({
      year: 2024,
      currentYear: 2026,
      maxPages: 2,
      fetchPage: async (_url, page) => {
        if (page === 1) {
          firstPageReads += 1;
          return dejurePage([
            { date: "31.12.2024", docket: firstPageReads === 1 ? "1 BvR 20/24" : "1 BvR 21/24" },
          ], [2]);
        }
        return dejurePage([{ date: "31.12.2023", docket: "1 BvR 30/23" }], [1]);
      },
    }),
    /changed during pagination/,
  );
});

test("read-only verifier seals a bounded report and never authorizes writes or Gemini", async () => {
  const fixtures = new Map<number, string>([
    [1, dejurePage([
      { date: "10.01.2025", docket: "1 BvR 10/25" },
      { date: "31.12.2024", docket: "1 BvR 20/24" },
    ], [2, 3])],
    [2, dejurePage([{ date: "02.01.2024", docket: "2 BvR 547/21" }], [1, 3])],
    [3, dejurePage([{ date: "31.12.2023", docket: "1 BvR 30/23" }], [1, 2])],
  ]);
  const inventory = await discoverBverfgInventory({
    year: 2024,
    currentYear: 2026,
    maxPages: 3,
    fetchPage: async (_url, page) => {
      const fixture = fixtures.get(page);
      if (!fixture) throw new Error("unexpected page");
      return fixture;
    },
  });
  const report = await verifyBverfgInventoryReadOnly({ year: 2024, maxPages: 3 }, {
    discover: async () => inventory,
  });
  assert.equal(report.inventoryContractVerified, true);
  assert.equal(report.productionWriteAuthorized, false);
  assert.equal(report.geminiCalls, 0);
  assert.equal(report.coverageAssurance, "external_index_assisted");
  assert.equal(report.officialCorpusCoverageClaimed, false);
  assert.equal(report.enumerationArtifactCount, 4);
  assert.match(report.enumerationArtifactManifestHash, /^[0-9a-f]{64}$/);

  assert.throws(() => validateBverfgInventoryResult({
    ...inventory,
    enumerationArtifacts: inventory.enumerationArtifacts.map((artifact, index) => index === 0 ? {
      ...artifact,
      safeDetails: { ...artifact.safeDetails, externalText: "must not be stored" },
    } : artifact),
  }), /artifact_contract_invalid/);
});

const reviewedGermanyPolicy: BverfgShadowPolicyEvidence = {
  sourceKey: "de-bverfg",
  policyVersion: "bverfg-reviewed-v1",
  officialScopeUrl: "https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html",
  discoveryMethods: ["external_index_dejure_paged_listing"],
  authorityHosts: ["www.bundesverfassungsgericht.de"],
  redirectHosts: ["www.bverfg.de"],
  externalIndexHosts: ["dejure.org"],
  robotsUrl: "https://www.bundesverfassungsgericht.de/robots.txt",
  licenseBasis: "official-public-record",
  defaultTextAccessPolicy: "metadata_only",
  allowRawSnapshot: false,
  normalizeReplayPolicy: "bounded_evidence",
  boundedReplayFields: ["sourceKey", "url", "canonicalUrl", "title", "publishedAt", "contentType", "text", "metadata"],
  retentionDays: 365,
  minRequestDelayMs: 30_000,
  maxConcurrency: 1,
  reviewedBy: "catalog-owner",
  reviewedAt: "2026-09-03T00:00:00.000Z",
  reviewDueAt: "2027-09-03T00:00:00.000Z",
};

function shadowRepository(input: {
  policy?: BverfgShadowPolicyEvidence | null;
  snapshots?: Awaited<ReturnType<BverfgShadowReadinessRepository["listAnnualSnapshots"]>>;
} = {}): BverfgShadowReadinessRepository {
  return {
    async getPolicy() { return input.policy === undefined ? reviewedGermanyPolicy : input.policy; },
    async listAnnualSnapshots() { return input.snapshots ?? []; },
  };
}

test("private-shadow readiness is read-only and requires every owner policy decision", async () => {
  const ready = await verifyBverfgPrivateShadowReadiness({
    year: 2024,
    policyVersion: reviewedGermanyPolicy.policyVersion,
    environment: { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" },
  }, {
    repository: shadowRepository(),
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    currentYear: 2026,
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.nextAction, "open_private_shadow_snapshot");
  assert.equal(ready.ownerApprovalRecorded, true);
  assert.equal(ready.readOnly, true);
  assert.equal(ready.productionWriteAuthorizedByThisCheck, false);
  assert.equal(ready.publicCatalogEnabledByThisCheck, false);
  assert.equal(ready.geminiCalls, 0);

  const blocked = await verifyBverfgPrivateShadowReadiness({
    year: 2024,
    policyVersion: reviewedGermanyPolicy.policyVersion,
    environment: {},
  }, {
    repository: shadowRepository({ policy: null }),
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    currentYear: 2026,
  });
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.blocking, ["germany_history_flag_disabled", "immutable_source_policy_missing"]);
});

test("private-shadow readiness resumes one open snapshot and recognizes only fully sealed completion", async () => {
  const base = {
    sourcePolicyVersion: reviewedGermanyPolicy.policyVersion,
    openedAt: "2026-09-04T00:00:00.000Z",
    closedAt: null,
    manifestHash: null,
    enumerationManifestHash: null,
  };
  const resumable = await verifyBverfgPrivateShadowReadiness({
    year: 2024,
    policyVersion: reviewedGermanyPolicy.policyVersion,
    environment: { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" },
  }, {
    repository: shadowRepository({ snapshots: [{ ...base,id: "00000000-0000-4000-8000-000000000321",status: "open" }] }),
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    currentYear: 2026,
  });
  assert.equal(resumable.status, "ready");
  assert.equal(resumable.nextAction, "resume_existing_private_shadow");

  const complete = await verifyBverfgPrivateShadowReadiness({
    year: 2024,
    policyVersion: reviewedGermanyPolicy.policyVersion,
    environment: { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" },
  }, {
    repository: shadowRepository({ snapshots: [{
      ...base,
      id: "00000000-0000-4000-8000-000000000322",
      status: "closed",
      closedAt: "2026-09-04T01:00:00.000Z",
      manifestHash: "a".repeat(64),
      enumerationManifestHash: "b".repeat(64),
    }] }),
    now: () => new Date("2026-09-04T02:00:00.000Z"),
    currentYear: 2026,
  });
  assert.equal(complete.status, "complete");
  assert.equal(complete.nextAction, "inspect_private_shadow_reconciliation");
});

test("Germany discovery persists enumeration evidence before items and closes one manifest", async () => {
  const openSnapshot: CaseBackfillSnapshot = {
    id: "00000000-0000-4000-8000-000000000311",
    sourceKey: "de-bverfg",
    scopeFrom: "2024-01-01",
    scopeTo: "2024-12-31",
    documentType: "DECISION",
    parserVersion: "bverfg-official-normalize-v1",
    sourcePolicyVersion: "bverfg-policy-v1",
    status: "open",
  };
  const authority: CaseBackfillAttemptAuthority = {
    attemptId: "00000000-0000-4000-8000-000000000312",
    runId: "00000000-0000-4000-8000-000000000313",
    fencingToken: "23",
    leaseExpiresAt: "2026-09-04T12:00:00.000Z",
  };
  const pass: CaseBackfillPassInput = {
    cohort: "catalog-backfill",
    snapshotId: openSnapshot.id,
    phase: "discover",
    passNumber: 1,
    batchLimit: 50,
  };
  const artifact = {
    providerKey: "dejure.org",
    artifactKind: "page" as const,
    sequenceNumber: 1,
    requestUrl: "https://dejure.org/dienste/rechtsprechung?gericht=BVerfG",
    responseHash: "a".repeat(64),
    recordManifestHash: "b".repeat(64),
    recordCount: 1,
    newestDecisionDate: "2024-03-26",
    oldestDecisionDate: "2024-03-26",
    observedLastPage: 425,
    safeDetails: { storesExternalText: false },
  };
  const inventoryItem = {
    stableItemKey: "dejure:2024-03-26:2bvr54721",
    sourceRecordId: null,
    discoveredUrl: "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2024/03/rk20240326_2bvr054721.html",
    documentType: "DECISION" as const,
    decisionDateHint: "2024-03-26",
    title: "Beschluss",
    inventoryMetadata: { docket: "2 BvR 547/21", officialUrlCandidates: [] },
  };
  const calls: string[] = [];
  const unavailable = async () => { throw new Error("unused"); };
  const repository = {
    openSnapshot: unavailable,
    upsertInventoryItem: async () => { calls.push("item"); return "00000000-0000-4000-8000-000000000315"; },
    recordEnumerationArtifact: async (input: { artifact: { responseHash: string } }) => {
      assert.equal(input.artifact.responseHash, artifact.responseHash);
      calls.push("artifact");
      return "00000000-0000-4000-8000-000000000314";
    },
    updateSnapshotEvidence: async () => { calls.push("evidence"); },
    closeSnapshot: async () => {
      calls.push("close");
      return {
        snapshotId: openSnapshot.id,
        sourceKey: openSnapshot.sourceKey,
        snapshotStatus: "closed",
        discoveredTotal: 1,
        terminalTotal: 0,
        processingCompletion: 0,
        expectedCount: null,
        coverageAssurance: "external_index_assisted" as const,
        corpusCoverage: null,
        claimed: 0,
        retryWait: 0,
        needsNormalize: 0,
        needsReverify: 0,
        needsRepublish: 0,
        failed: 0,
        currentConformant: 0,
        currentConformance: 0,
        manifestHash: "c".repeat(64),
      };
    },
    getSnapshot: async () => openSnapshot,
    getSourcePolicy: async () => ({
      sourceKey: openSnapshot.sourceKey,
      policyVersion: openSnapshot.sourcePolicyVersion,
      normalizeReplayPolicy: "bounded_evidence" as const,
      boundedReplayFields: ["sourceKey", "url", "canonicalUrl", "title", "publishedAt", "contentType", "text", "metadata"],
      minRequestDelayMs: 30_000,
      maxConcurrency: 1,
      reviewDueAt: "2027-09-04T00:00:00.000Z",
    }),
    getSnapshotStatus: unavailable,
    acquireSourceRequestPermit: unavailable,
    releaseSourceRequestPermit: unavailable,
    beginRun: async () => "00000000-0000-4000-8000-000000000316",
    allocatePass: unavailable,
    finishRun: async () => { calls.push("finish"); },
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
  } as CaseBackfillRepository;

  const result = await runCaseBackfillPass(pass, {
    authority,
    checkpoint: async () => undefined,
    signal: new AbortController().signal,
  }, {
    repository,
    loadAdapter: async () => null,
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    environment: { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" },
    discoverBverfgInventory: async () => ({
      sourceKey: "de-bverfg",
      year: 2024,
      documentType: "DECISION",
      items: [inventoryItem],
      pageCount: 1,
      requestCount: 2,
      expectedCount: null,
      expectedCountBasis: null,
      enumerationArtifacts: [artifact],
      coverageEvidence: {
        coverageAssurance: "external_index_assisted",
        officialCorpusCoverageClaimed: false,
      },
    }),
  });
  assert.deepEqual(calls, ["artifact", "item", "evidence", "close", "finish"]);
  assert.equal(result.succeeded, 1);
});

const snapshot: CaseBackfillSnapshot = {
  id: "00000000-0000-4000-8000-000000000301",
  sourceKey: "de-bverfg",
  scopeFrom: "2024-01-01",
  scopeTo: "2024-12-31",
  documentType: "DECISION",
  parserVersion: "bverfg-official-normalize-v1",
  sourcePolicyVersion: "bverfg-policy-v1",
  status: "closed",
};

const item: CaseBackfillClaimedItem = {
  itemId: "00000000-0000-4000-8000-000000000302",
  stableItemKey: "dejure:2024-03-26:2bvr54721",
  sourceRecordId: null,
  discoveredUrl: "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2024/03/rk20240326_2bvr054721.html",
  authorityUrl: null,
  documentType: "DECISION",
  decisionDateHint: "2024-03-26",
  inventoryMetadata: {
    docket: "2 BvR 547/21",
    officialUrlCandidates: [
      "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2024/03/rk20240326_2bvr054721.html",
      "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2024/03/rs20240326_2bvr054721.html",
    ],
  },
  resolutionStatus: "discovered",
  currentFetchArtifactId: null,
  currentNormalizationArtifactId: null,
  verifiedNormalizationArtifactId: null,
  publishedNormalizationArtifactId: null,
  itemLeaseExpiresAt: "2026-09-04T00:00:00.000Z",
};

function normalized(overrides: Partial<NormalizedArticle> = {}): NormalizedArticle {
  return {
    sourceKey: "de-bverfg",
    jurisdiction: "Germany",
    institutionName: "Bundesverfassungsgericht",
    contentType: "decision",
    originalUrl: item.discoveredUrl,
    canonicalUrl: item.discoveredUrl,
    originalLanguage: "de",
    originalTitle: "Beschluss vom 26. März 2024",
    originalPublishedAt: "2024-03-26T00:00:00.000Z",
    cleanedText: "Amtlicher Entscheidungstext ".repeat(100),
    metadata: {
      decisionDate: "2024-03-26",
      caseNumber: "2 BvR 547/21",
      collection: { sourceUrlVerified: true, sourceTextAvailable: true, publishable: true },
    },
    ...overrides,
  };
}

test("Germany strategy requires the flag and verifies official authority identity", () => {
  const strategy = loadCaseBackfillSourceStrategy("de-bverfg", { currentYear: 2026 });
  assert.throws(() => strategy.assertDiscoveryScope(snapshot, {}), /germany_history_disabled/);
  assert.doesNotThrow(() => strategy.assertDiscoveryScope(snapshot, {
    [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true",
  }));
  assert.deepEqual(strategy.validate(normalized(), item, snapshot), []);
  assert.ok(strategy.validate(normalized({
    canonicalUrl: "https://dejure.org/dienste/rechtsprechung?gericht=BVerfG",
  }), item, snapshot).includes("authority_url_invalid"));
  assert.ok(strategy.validate(normalized({
    metadata: {
      decisionDate: "2024-03-26",
      caseNumber: "2 BvR 547/21",
      collection: { sourceUrlVerified: false, sourceTextAvailable: true, publishable: true },
    },
  }), item, snapshot).includes("official_source_not_verified"));
  assert.ok(strategy.validate(normalized({
    metadata: {
      decisionDate: "2024-03-26",
      caseNumber: "1 BvR 1/24",
      collection: { sourceUrlVerified: true, sourceTextAvailable: true, publishable: true },
    },
  }), item, snapshot).includes("docket_mismatch"));
  assert.ok(strategy.validate(normalized({
    cleanedText: "",
    metadata: {
      decisionDate: "2024-03-26",
      caseNumber: "2 BvR 547/21",
      collection: { sourceUrlVerified: true, sourceTextAvailable: false, publishable: false },
    },
  }), item, snapshot).includes("official_source_text_missing"));
});

test("BVerfG fetch candidates come from sealed inventory and reject non-official URLs", () => {
  const candidates = bverfgOfficialUrlCandidatesForItem({
    sourceKey: "de-bverfg",
    url: item.discoveredUrl,
    canonicalUrl: item.discoveredUrl,
    contentType: "decision",
    metadata: {
      sourceInventory: {
        officialUrlCandidates: [
          "https://attacker.example/SharedDocs/Entscheidungen/DE/2024/03/rk20240326_2bvr054721.html",
          ...(item.inventoryMetadata.officialUrlCandidates as string[]),
        ],
      },
    },
  });
  assert.deepEqual(candidates, item.inventoryMetadata.officialUrlCandidates);
  assert.deepEqual(bverfgOfficialUrlCandidatesForItem({
    sourceKey: "de-bverfg",
    url: "https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html",
    canonicalUrl: "https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html",
    contentType: "decision",
    metadata: { sourceInventory: { officialUrlCandidates: [] } },
  }), []);
});
