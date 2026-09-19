import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  CASE_HISTORY_BOUNDARY,
  COUNTRY_HISTORY_EXPANSION_ORDER,
  HISTORICAL_GATE_MAX_YEAR,
  INCREMENTAL_INGESTION_OWNED_FROM_YEAR,
  assertHistoricalGateYear,
  assertHistoricalSnapshotBoundary,
  caseHistoryBoundaryDescriptor,
  countryHistoryStage,
  isHistoricalGateYear,
  isIncrementalIngestionYear,
} from "../lib/backfill/country-history-policy";
import { runCaseBackfillPass } from "../lib/backfill/service";
import type { CaseBackfillRepository } from "../lib/backfill/repository";
import type { CaseBackfillAttemptAuthority, CaseBackfillSnapshot } from "../lib/backfill/types";
import { germanyBverfgYearScope } from "../lib/backfill/germany-scope";
import { franceConseilScope } from "../lib/backfill/france-scope";
import { spainSentenciaYearScope } from "../lib/backfill/spain-scope";

test("Gate 5 historical boundary is pre-2025 and 2025+ is owned by incremental ingestion", () => {
  assert.equal(HISTORICAL_GATE_MAX_YEAR, 2024);
  assert.equal(INCREMENTAL_INGESTION_OWNED_FROM_YEAR, 2025);
  assert.deepEqual(CASE_HISTORY_BOUNDARY, {
    gate: 5,
    historicalMaxYear: 2024,
    incrementalOwnedFromYear: 2025,
    rule: "pre_2025_gate5_historical",
  });
  assert.equal(isIncrementalIngestionYear(2024), false);
  assert.equal(isIncrementalIngestionYear(2025), true);
  assert.equal(isIncrementalIngestionYear(2026), true);
  assert.equal(isHistoricalGateYear(2024), true);
  assert.equal(isHistoricalGateYear(2025), false);
  assert.equal(assertHistoricalGateYear(2024, 2026), 2024);
  assert.throws(() => assertHistoricalGateYear(2025, 2026), /historical_year_out_of_gate5_boundary/);
  assert.throws(() => assertHistoricalGateYear(2020, 2018), /historical_year_in_future/);
});

test("country expansion order is machine-readable and readiness-ordered", () => {
  const descriptor = caseHistoryBoundaryDescriptor();
  assert.equal(descriptor.rule, "pre_2025_gate5_historical");
  assert.deepEqual(descriptor.expansionOrder, COUNTRY_HISTORY_EXPANSION_ORDER.map((stage) => ({ ...stage })));
  assert.deepEqual(
    COUNTRY_HISTORY_EXPANSION_ORDER.map((stage) => [stage.order, stage.country, stage.status]),
    [
      [1, "Germany", "approved_private_shadow"],
      [2, "France", "approved_source_policy"],
      [3, "France", "pending_owner_approval"],
      [4, "Spain", "blocked_source_policy"],
      [5, "Spain", "blocked_source_policy"],
      [6, "Spain", "blocked_source_policy"],
      [7, "United States", "candidate_graph_only"],
    ],
  );
  assert.equal(caseHistoryBoundaryDescriptor().expansionOrder[0].policyVersion, "bverfg-unattended-canary-v2");
  assert.equal(caseHistoryBoundaryDescriptor().expansionOrder[0].policyReviewDueAt, "2027-03-15");
  assert.equal(caseHistoryBoundaryDescriptor().expansionOrder[0].approvedYearFrom, 2023);
  assert.equal(caseHistoryBoundaryDescriptor().expansionOrder[0].approvedYearTo, 2024);
  assert.equal(caseHistoryBoundaryDescriptor().expansionOrder[1].policyVersion, "france-dila-constit-2026-09-v2");
  assert.equal(caseHistoryBoundaryDescriptor().expansionOrder[1].policyReviewDueAt, "2027-03-15");
  assert.equal(caseHistoryBoundaryDescriptor().expansionOrder[1].approvedYearFrom, 2010);
  assert.equal(caseHistoryBoundaryDescriptor().expansionOrder[1].approvedYearTo, 2024);
  assert.equal(caseHistoryBoundaryDescriptor().expansionOrder[2].policyVersion, null);
  assert.deepEqual(countryHistoryStage("fr-conseil-constitutionnel").map((stage) => stage.documentTypes), [
    ["QPC", "DC"],
    ["L", "LP", "OTHER_CONSEIL_NATURE"],
  ]);
  assert.deepEqual(countryHistoryStage("es-tribunal-constitucional").map((stage) => [stage.yearFrom, stage.yearTo]), [
    [2020, 2024],
    [1980, 2019],
    [1980, 2024],
  ]);
  assert.equal(countryHistoryStage("us-constitution-annotated")[0].status, "candidate_graph_only");
});

test("all country annual scopes reject 2025 and later before the historical ledger", () => {
  assert.throws(() => germanyBverfgYearScope(2025, 2026), /germany_year_not_supported/);
  assert.throws(() => franceConseilScope(2025, "QPC", 2026), /france_year_not_supported/);
  assert.throws(() => spainSentenciaYearScope(2025), /spain_year_not_supported/);
  assert.throws(
    () => assertHistoricalSnapshotBoundary({ scopeFrom: "2025-01-01", scopeTo: "2025-12-31" }),
    /case_backfill\.incremental_year_not_historical/,
  );
  const boundary = assertHistoricalSnapshotBoundary({ scopeFrom: "2024-01-01", scopeTo: "2024-12-31" });
  assert.deepEqual(boundary, { fromYear: 2024, toYear: 2024, boundary: CASE_HISTORY_BOUNDARY });
  assert.throws(
    () => assertHistoricalSnapshotBoundary({ scopeFrom: null, scopeTo: null }),
    /case_backfill\.historical_scope_missing/,
  );
});

const authority: CaseBackfillAttemptAuthority = {
  attemptId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  fencingToken: "17",
  leaseExpiresAt: "2026-09-03T12:00:00.000Z",
};

function incrementalSnapshot(): CaseBackfillSnapshot {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    sourceKey: "de-bverfg",
    scopeFrom: "2025-01-01",
    scopeTo: "2025-12-31",
    documentType: "DECISION",
    parserVersion: "bverfg-official-normalize-v2",
    sourcePolicyVersion: "bverfg-policy-v1",
    status: "closed",
  };
}

function fakeRepository(snapshot: CaseBackfillSnapshot, onBeginRun: () => void): CaseBackfillRepository {
  const unavailable = async () => { throw new Error("unused"); };
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
      minRequestDelayMs: 30_000,
      maxConcurrency: 1,
      reviewDueAt: "2027-09-03T00:00:00.000Z",
    }),
    getSnapshotStatus: unavailable,
    acquireSourceRequestPermit: unavailable,
    releaseSourceRequestPermit: unavailable,
    allocatePass: unavailable,
    beginRun: async () => { onBeginRun(); return "55555555-5555-4555-8555-555555555555"; },
    finishRun: unavailable,
    countBacklog: async () => 0,
    countResidualClaims: async () => 0,
    listNonTerminalRuns: async () => [],
    claimItems: async () => [],
    extendItems: async (ids) => ids.length,
    recordEnumerationArtifact: unavailable,
    recordFetchArtifact: unavailable,
    getFetchArtifact: unavailable,
    getNormalizationArtifact: unavailable,
    recordNormalizationArtifact: unavailable,
    publishItem: unavailable,
    completeItem: unavailable,
    excludeItem: unavailable,
    failItem: unavailable,
    listArtifactExternalizationCandidates: unavailable,
    attachArtifactExternalization: unavailable,
    listArtifactInlineClearCandidates: unavailable,
    clearArtifactInline: unavailable,
  } as CaseBackfillRepository;
}

test("P1 worker backfill passes reject a 2025 snapshot before any run row is created", async () => {
  for (const phase of ["discover", "fetch", "normalize", "verify", "reconcile"] as const) {
    let began = false;
    const snapshot = { ...incrementalSnapshot(), status: phase === "discover" ? "open" : "closed" };
    await assert.rejects(
      runCaseBackfillPass({
        cohort: "catalog-backfill",
        snapshotId: snapshot.id,
        phase,
        passNumber: 1,
        batchLimit: 2,
      }, {
        authority,
        checkpoint: async () => undefined,
        signal: new AbortController().signal,
      }, {
        repository: fakeRepository(snapshot, () => { began = true; }),
        loadAdapter: async () => null,
        now: () => new Date("2026-09-03T00:00:00.000Z"),
        environment: { CASE_CATALOG_GERMANY_HISTORY_ENABLED: "true" },
      }),
      /case_backfill\.incremental_year_not_historical/,
    );
    assert.equal(began, false, `${phase} must not create a run`);
  }
});

test("2025+ incremental ingestion workflow stays decoupled from the historical guard", () => {
  const ingestRun = fs.readFileSync(path.join(process.cwd(), "lib/ingest/run.ts"), "utf8");
  assert.doesNotMatch(ingestRun, /country-history-policy|assertHistoricalSnapshotBoundary/);
  assert.equal(isIncrementalIngestionYear(2026), true);
  assert.throws(() => assertHistoricalGateYear(2026, 2026), /historical_year_out_of_gate5_boundary/);

  const cli = fs.readFileSync(path.join(process.cwd(), "scripts/backfill-corpus.ts"), "utf8");
  assert.match(cli, /boundary: CASE_HISTORY_BOUNDARY/);
  assert.match(cli, /expansionOrder: COUNTRY_HISTORY_EXPANSION_ORDER/);
  assert.match(cli, /HISTORICAL_GATE_MAX_YEAR/);
});
