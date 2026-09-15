import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertCaseBackfillRolloutPreflight,
  caseBackfillRolloutReadiness,
  preflightCaseBackfillRollout,
  selectCaseBackfillRollout,
} from "../lib/backfill/rollout-readiness";
import { CASE_CATALOG_GERMANY_HISTORY_FLAG } from "../lib/backfill/germany-scope";
import { CASE_CATALOG_FRANCE_HISTORY_FLAG } from "../lib/backfill/france-scope";
import { CASE_CATALOG_SPAIN_HISTORY_FLAG } from "../lib/backfill/spain-scope";
import { CASE_CATALOG_WRITE_FLAG } from "../lib/case-catalog/flags";
import { runCaseBackfillPass } from "../lib/backfill/service";
import type { CaseBackfillRepository } from "../lib/backfill/repository";
import type {
  CaseBackfillAttemptAuthority,
  CaseBackfillSnapshot,
} from "../lib/backfill/types";
import type { SourceAdapter } from "../lib/sources/types";

const NOW = () => new Date("2026-09-16T00:00:00.000Z");

test("M5 readiness authorizes only the existing Germany 2024 canary and reports the exact blocker", () => {
  const report = caseBackfillRolloutReadiness({ environment: {}, currentYear: 2026, now: NOW });

  assert.equal(report.event, "case_backfill_rollout_readiness");
  assert.equal(report.rule, "pre_2025_gate5_historical");
  assert.equal(report.historicalMaxYear, 2024);
  assert.equal(report.incrementalOwnedFromYear, 2025);
  assert.equal(report.machineReadable, true);
  assert.equal(report.geminiCalls, 0);
  assert.equal(report.catalogWriteEnabled, false);
  assert.equal(report.publicCatalogEnabled, false);
  assert.equal(report.observedAt, "2026-09-16T00:00:00.000Z");
  assert.equal(report.tranches.length, 7);
  assert.deepEqual(
    report.tranches.map((tranche) => [tranche.order, tranche.country, tranche.status]),
    [
      [1, "Germany", "approved_private_shadow"],
      [2, "France", "pending_owner_approval"],
      [3, "France", "pending_owner_approval"],
      [4, "Spain", "blocked_source_policy"],
      [5, "Spain", "blocked_source_policy"],
      [6, "Spain", "blocked_source_policy"],
      [7, "United States", "candidate_graph_only"],
    ],
  );

  const germany = report.tranches[0];
  assert.deepEqual(germany.approvedYears, [2024]);
  assert.equal(germany.policyAuthorized, true);
  assert.equal(germany.executionEnabled, false);
  assert.equal(report.approvedSelectionCount, 1);
  assert.deepEqual(
    report.approvedSelections.map((entry) => [entry.sourceKey, entry.year, entry.documentType]),
    [["de-bverfg", 2024, "DECISION"]],
  );
  assert.equal(report.newlyAuthorizedSelectionCount, 0);
  assert.equal(report.m5ExpansionExecutionReady, false);
  assert.equal(report.tranches.filter((tranche) => !tranche.policyAuthorized).length, 6);
  assert.deepEqual(report.nextApprovalRequired, {
    trancheOrder: 2,
    country: "France",
    sourceKey: "fr-conseil-constitutionnel",
    documentTypes: ["QPC", "DC"],
    status: "pending_owner_approval",
    blocking: ["owner_source_policy_not_approved"],
  });
});

test("Germany 2024 is authorized only when the approved policy and history flag both hold", () => {
  const flag = { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" };
  const enabled = selectCaseBackfillRollout(
    { sourceKey: "de-bverfg", year: 2024, documentType: "DECISION" },
    { environment: flag, currentYear: 2026 },
  );
  assert.equal(enabled.policyAuthorized, true);
  assert.equal(enabled.executionEnabled, true);
  assert.equal(enabled.allowed, true);
  assert.equal(enabled.errorCode, null);
  assert.deepEqual(enabled.blocking, []);

  const disabled = selectCaseBackfillRollout(
    { sourceKey: "de-bverfg", year: 2024, documentType: "DECISION" },
    { environment: {}, currentYear: 2026 },
  );
  assert.equal(disabled.policyAuthorized, true);
  assert.equal(disabled.executionEnabled, false);
  assert.equal(disabled.allowed, false);
  assert.equal(disabled.errorCode, "case_backfill.germany_history_disabled");
});

test("Germany 1998-2023 expansion stays unapproved even with the history flag on", () => {
  for (const year of [1998, 2010, 2023]) {
    const result = selectCaseBackfillRollout(
      { sourceKey: "de-bverfg", year, documentType: "DECISION" },
      { environment: { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" }, currentYear: 2026 },
    );
    assert.equal(result.policyAuthorized, false);
    assert.equal(result.allowed, false);
    assert.equal(result.errorCode, "case_backfill.germany_expansion_not_approved");
  }
  assert.throws(
    () => assertCaseBackfillRolloutPreflight(
      { sourceKey: "de-bverfg", year: 2023, documentType: "DECISION" },
      { environment: { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" }, currentYear: 2026 },
    ),
    /case_backfill\.germany_expansion_not_approved/,
  );
  assert.doesNotThrow(() => assertCaseBackfillRolloutPreflight(
    { sourceKey: "de-bverfg", year: 2024, documentType: "DECISION" },
    { environment: { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" }, currentYear: 2026 },
  ));
});

test("France QPC/DC stays pending owner approval and the history flag alone cannot open it", () => {
  const flag = { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" };
  const qpc = selectCaseBackfillRollout(
    { sourceKey: "fr-conseil-constitutionnel", year: 2024, documentType: "QPC" },
    { environment: flag, currentYear: 2026 },
  );
  assert.equal(qpc.trancheOrder, 2);
  assert.equal(qpc.policyAuthorized, false);
  assert.equal(qpc.allowed, false);
  assert.equal(qpc.errorCode, "case_backfill.france_history_source_policy_not_approved");
  assert.deepEqual(qpc.blocking, ["owner_source_policy_not_approved"]);

  const otherNature = selectCaseBackfillRollout(
    { sourceKey: "fr-conseil-constitutionnel", year: 2024, documentType: "L" },
    { environment: flag, currentYear: 2026 },
  );
  assert.equal(otherNature.trancheOrder, 3);
  assert.equal(otherNature.allowed, false);
  assert.equal(otherNature.errorCode, "case_backfill.france_history_source_policy_not_approved");

  const unknownType = selectCaseBackfillRollout(
    { sourceKey: "fr-conseil-constitutionnel", year: 2024, documentType: "XYZ" },
    { environment: flag, currentYear: 2026 },
  );
  assert.equal(unknownType.errorCode, "case_backfill.discovery_scope_not_enabled");

  assert.equal(
    selectCaseBackfillRollout(
      { sourceKey: "fr-conseil-constitutionnel", year: 2009, documentType: "QPC" },
      { environment: flag, currentYear: 2026 },
    ).errorCode,
    "case_backfill.france_year_not_supported",
  );
});

test("France selection can open only when an owner policy is explicitly injected", () => {
  const enabled = selectCaseBackfillRollout(
    { sourceKey: "fr-conseil-constitutionnel", year: 2024, documentType: "QPC" },
    {
      environment: { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" },
      currentYear: 2026,
      franceHistorySourcePolicyApproved: true,
    },
  );
  assert.equal(enabled.policyAuthorized, true);
  assert.equal(enabled.executionEnabled, true);
  assert.equal(enabled.allowed, true);
});

test("Spain historical scope is blocked and 2024 baseline is fail-closed without policy approval", () => {
  const flag = { [CASE_CATALOG_SPAIN_HISTORY_FLAG]: "true" };
  for (const year of [2020, 2024]) {
    const result = selectCaseBackfillRollout(
      { sourceKey: "es-tribunal-constitucional", year, documentType: "SENTENCIA" },
      { environment: flag, currentYear: 2026 },
    );
    assert.equal(result.allowed, false);
    assert.equal(result.errorCode, "case_backfill.spain_history_source_blocked");
    assert.deepEqual(result.blocking, ["spain_hj_legal_robots_policy_blocked"]);
  }
  const auto = selectCaseBackfillRollout(
    { sourceKey: "es-tribunal-constitucional", year: 2024, documentType: "AUTO" },
    { environment: flag, currentYear: 2026 },
  );
  assert.equal(auto.trancheOrder, 6);
  assert.equal(auto.errorCode, "case_backfill.discovery_scope_not_enabled");
  assert.equal(
    selectCaseBackfillRollout(
      { sourceKey: "es-tribunal-constitucional", year: 1979, documentType: "SENTENCIA" },
      { environment: flag, currentYear: 2026 },
    ).errorCode,
    "case_backfill.spain_year_not_supported",
  );
});

test("United States Constitution Annotated stays candidate-graph only", () => {
  const result = selectCaseBackfillRollout(
    { sourceKey: "us-constitution-annotated", year: 2024, documentType: "CONSTITUTION_ANNOTATED_TABLE_CITATION" },
    { environment: {}, currentYear: 2026 },
  );
  assert.equal(result.trancheOrder, 7);
  assert.equal(result.trancheStatus, "candidate_graph_only");
  assert.equal(result.policyAuthorized, false);
  assert.equal(result.allowed, false);
  assert.equal(result.errorCode, "us_conan.candidate_graph_not_verified_corpus");
  assert.deepEqual(result.blocking, ["candidate_graph_is_not_verified_scotus_corpus"]);
});

test("2025+ selections are rejected before any source-specific policy path", () => {
  for (const sourceKey of ["de-bverfg", "fr-conseil-constitutionnel", "es-tribunal-constitucional"]) {
    const result = selectCaseBackfillRollout(
      { sourceKey, year: 2025, documentType: "DECISION" },
      { environment: {}, currentYear: 2026 },
    );
    assert.equal(result.allowed, false);
    assert.equal(result.errorCode, "case_backfill.incremental_year_not_historical");
    assert.equal(result.withinHistoricalBoundary, false);
  }
});

test("fail-closed preflight rejects every unapproved selection and proves zero public/AI effects", () => {
  const cases: Array<[Parameters<typeof selectCaseBackfillRollout>[0], string]> = [
    [{ sourceKey: "de-bverfg", year: 2023, documentType: "DECISION" }, "case_backfill.germany_expansion_not_approved"],
    [{ sourceKey: "fr-conseil-constitutionnel", year: 2024, documentType: "QPC" }, "case_backfill.france_history_source_policy_not_approved"],
    [{ sourceKey: "es-tribunal-constitucional", year: 2024, documentType: "SENTENCIA" }, "case_backfill.spain_history_source_blocked"],
    [{ sourceKey: "us-constitution-annotated", year: 2024, documentType: "CONSTITUTION_ANNOTATED_TABLE_CITATION" }, "us_conan.candidate_graph_not_verified_corpus"],
  ];
  for (const [input, errorCode] of cases) {
    const preflight = preflightCaseBackfillRollout(input, { environment: {}, currentYear: 2026 });
    assert.equal(preflight.event, "case_backfill_rollout_preflight");
    assert.equal(preflight.allowed, false);
    assert.equal(preflight.errorCode, errorCode);
    assert.equal(preflight.publicCatalogWrites, 0);
    assert.equal(preflight.geminiCalls, 0);
    assert.throws(() => assertCaseBackfillRolloutPreflight(input, { environment: {}, currentYear: 2026 }), new RegExp(errorCode.replace(/[.]/g, "\\.")));
  }
});

test("readiness stays catalog-write aware without enabling publication or AI", () => {
  const report = caseBackfillRolloutReadiness({
    environment: { [CASE_CATALOG_WRITE_FLAG]: "false" },
    currentYear: 2026,
    now: NOW,
  });
  assert.equal(report.catalogWriteEnabled, false);
  assert.equal(report.publicCatalogEnabled, false);
  assert.equal(report.geminiCalls, 0);
  assert.equal(report.m5ExpansionExecutionReady, false);
});

test("CLI preflight gates snapshot and pass creation, and the evidence CLI is wired", () => {
  const cli = fs.readFileSync(path.join(process.cwd(), "scripts/backfill-corpus.ts"), "utf8");
  const germanyPreflight = cli.indexOf('preflightRolloutOrThrow({ sourceKey: "de-bverfg"');
  const openSnapshot = cli.indexOf("postgresCaseBackfillRepository.openSnapshot");
  const submitPreflight = cli.indexOf("assertCaseBackfillRolloutPreflight");
  assert.ok(germanyPreflight >= 0, "discovery preflight must be present");
  assert.ok(submitPreflight >= 0, "submit preflight must be present");
  assert.ok(openSnapshot > germanyPreflight, "rollout preflight must run before a snapshot is opened");
  assert.match(cli, /rolloutSelection: rolloutSelection/);
  assert.match(cli, /case_backfill\.rollout_not_authorized|preflight\.errorCode/);

  const evidence = fs.readFileSync(path.join(process.cwd(), "scripts/rollout-readiness.ts"), "utf8");
  assert.match(evidence, /caseBackfillRolloutReadiness/);
  assert.match(evidence, /preflightCaseBackfillRollout/);
  assert.match(evidence, /require-authorized/);

  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(pkg.scripts["rollout:readiness"], "tsx scripts/rollout-readiness.ts");
  assert.match(pkg.scripts["test:backfill"], /constitutional-case-rollout-readiness-gate5\.test\.ts/);
});

const defenseAuthority: CaseBackfillAttemptAuthority = {
  attemptId: "00000000-0000-4000-8000-000000000901",
  runId: "00000000-0000-4000-8000-000000000902",
  fencingToken: "41",
  leaseExpiresAt: "2026-09-16T12:00:00.000Z",
};

function defenseSnapshot(overrides: Partial<CaseBackfillSnapshot>): CaseBackfillSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000903",
    sourceKey: "de-bverfg",
    scopeFrom: "2024-01-01",
    scopeTo: "2024-12-31",
    documentType: "DECISION",
    parserVersion: "bverfg-official-normalize-v2",
    sourcePolicyVersion: "bverfg-policy-v1",
    status: "closed",
    ...overrides,
  };
}

function defenseRepository(snapshot: CaseBackfillSnapshot, onBeginRun: () => void): CaseBackfillRepository {
  const unavailable = async () => { throw new Error("unused"); };
  return {
    openSnapshot: unavailable,
    upsertInventoryItem: unavailable,
    recordEnumerationArtifact: unavailable,
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
    beginRun: async () => { onBeginRun(); return "00000000-0000-4000-8000-000000000999"; },
    finishRun: async () => undefined,
    countBacklog: async () => 0,
    countResidualClaims: async () => 0,
    listNonTerminalRuns: async () => [],
    claimItems: async () => [],
    extendItems: async (ids) => ids.length,
    recordFetchArtifact: unavailable,
    getFetchArtifact: unavailable,
    getNormalizationArtifact: unavailable,
    recordNormalizationArtifact: unavailable,
    publishItem: unavailable,
    completeItem: unavailable,
    excludeItem: unavailable,
    failItem: unavailable,
  } as CaseBackfillRepository;
}

async function expectNoRun(
  snapshot: CaseBackfillSnapshot,
  phase: "discover" | "fetch" | "normalize" | "verify" | "reconcile",
  environment: Record<string, string | undefined>,
  pattern: RegExp,
) {
  let began = false;
  await assert.rejects(
    runCaseBackfillPass({
      cohort: "catalog-backfill",
      snapshotId: snapshot.id,
      phase,
      passNumber: 1,
      batchLimit: 2,
    }, {
      authority: defenseAuthority,
      checkpoint: async () => undefined,
      signal: new AbortController().signal,
    }, {
      repository: defenseRepository(snapshot, () => { began = true; }),
      loadAdapter: async () => null,
      now: () => new Date("2026-09-16T00:00:00.000Z"),
      environment,
    }),
    pattern,
  );
  assert.equal(began, false, `${snapshot.sourceKey} ${phase} must not create a run`);
}

test("service defense blocks unapproved tranches in non-discover phases before beginRun", async () => {
  await expectNoRun(
    defenseSnapshot({ sourceKey: "de-bverfg", scopeFrom: "2023-01-01", scopeTo: "2023-12-31" }),
    "fetch",
    { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" },
    /case_backfill\.germany_expansion_not_approved/,
  );
  await expectNoRun(
    defenseSnapshot({ sourceKey: "fr-conseil-constitutionnel", scopeFrom: "2024-01-01", scopeTo: "2024-12-31", documentType: "QPC", sourcePolicyVersion: "france-policy-v1" }),
    "fetch",
    { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" },
    /case_backfill\.france_history_source_policy_not_approved/,
  );
  await expectNoRun(
    defenseSnapshot({ sourceKey: "es-tribunal-constitucional", scopeFrom: "2024-01-01", scopeTo: "2024-12-31", documentType: "SENTENCIA", sourcePolicyVersion: "spain-policy-v1" }),
    "fetch",
    { [CASE_CATALOG_SPAIN_HISTORY_FLAG]: "true" },
    /case_backfill\.spain_history_source_blocked/,
  );
  await expectNoRun(
    defenseSnapshot({ sourceKey: "es-tribunal-constitucional", scopeFrom: "2025-01-01", scopeTo: "2025-12-31", documentType: "SENTENCIA", sourcePolicyVersion: "spain-policy-v1" }),
    "fetch",
    {},
    /case_backfill\.incremental_year_not_historical/,
  );
});

test("service defense blocks unapproved tranches in discover phases before beginRun", async () => {
  await expectNoRun(
    defenseSnapshot({ sourceKey: "de-bverfg", scopeFrom: "2023-01-01", scopeTo: "2023-12-31", status: "open" }),
    "discover",
    { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" },
    /case_backfill\.germany_expansion_not_approved/,
  );
  await expectNoRun(
    defenseSnapshot({ sourceKey: "fr-conseil-constitutionnel", scopeFrom: "2024-01-01", scopeTo: "2024-12-31", documentType: "QPC", sourcePolicyVersion: "france-policy-v1", status: "open" }),
    "discover",
    { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" },
    /case_backfill\.france_history_source_policy_not_approved/,
  );
  await expectNoRun(
    defenseSnapshot({ sourceKey: "es-tribunal-constitucional", scopeFrom: "2024-01-01", scopeTo: "2024-12-31", documentType: "SENTENCIA", sourcePolicyVersion: "spain-policy-v1", status: "open" }),
    "discover",
    {},
    /case_backfill\.spain_history_source_blocked/,
  );
  await expectNoRun(
    defenseSnapshot({ sourceKey: "es-tribunal-constitucional", scopeFrom: "2025-01-01", scopeTo: "2025-12-31", documentType: "SENTENCIA", sourcePolicyVersion: "spain-policy-v1", status: "open" }),
    "discover",
    {},
    /case_backfill\.incremental_year_not_historical/,
  );
});

test("service defense lets the existing Germany 2024 canary proceed when policy and flag hold", async () => {
  let began = false;
  const snapshot = defenseSnapshot({});
  const adapter: SourceAdapter = {
    sourceKey: "de-bverfg",
    displayName: "Bundesverfassungsgericht",
    jurisdiction: "Germany",
    baseUrl: "https://www.bundesverfassungsgericht.de",
    defaultLanguage: "de",
    discover: async () => [],
    fetchItem: async () => { throw new Error("unused"); },
    normalize: async () => { throw new Error("unused"); },
  };
  const result = await runCaseBackfillPass({
    cohort: "catalog-backfill",
    snapshotId: snapshot.id,
    phase: "fetch",
    passNumber: 1,
    batchLimit: 2,
  }, {
    authority: defenseAuthority,
    checkpoint: async () => undefined,
    signal: new AbortController().signal,
  }, {
    repository: defenseRepository(snapshot, () => { began = true; }),
    loadAdapter: async () => adapter,
    now: () => new Date("2026-09-16T00:00:00.000Z"),
    environment: { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" },
  });
  assert.equal(began, true);
  assert.equal(result.succeeded, 0);
  assert.equal(result.backlogRemaining, false);
});

test("service source wires the rollout gate for both discover and non-discover before beginRun", () => {
  const service = fs.readFileSync(path.join(process.cwd(), "lib/backfill/service.ts"), "utf8");
  assert.match(service, /assertCaseBackfillRolloutPreflight/);
  assert.match(service, /assertRolloutAuthorized\(snapshot, dependencies\)/);
  const gates = service.match(/assertRolloutAuthorized\(snapshot, dependencies\)/g) ?? [];
  assert.equal(gates.length, 2, "discover and non-discover paths must both gate");
  const firstGate = service.indexOf("assertRolloutAuthorized(snapshot, dependencies)");
  const firstBeginRun = service.indexOf("repository.beginRun(");
  assert.ok(firstGate >= 0 && firstBeginRun > firstGate, "rollout gate must run before beginRun");
});
