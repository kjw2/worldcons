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

test("M5 readiness reports the approved Germany canary and the owner-approved France QPC/DC policy", () => {
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
      [2, "France", "approved_source_policy"],
      [3, "France", "pending_owner_approval"],
      [4, "Spain", "blocked_source_policy"],
      [5, "Spain", "blocked_source_policy"],
      [6, "Spain", "blocked_source_policy"],
      [7, "United States", "candidate_graph_only"],
    ],
  );

  const germany = report.tranches[0];
  assert.deepEqual(germany.approvedYears, [2023, 2024]);
  assert.equal(germany.policyAuthorized, true);
  assert.equal(germany.executionEnabled, false);
  assert.equal(germany.policyVersion, "bverfg-unattended-canary-v2");
  assert.equal(germany.policyReviewDueAt, "2027-03-15");

  const approvedYears: number[] = [];
  for (let year = 2010; year <= 2024; year += 1) approvedYears.push(year);
  const franceQpcDc = report.tranches[1];
  assert.deepEqual(franceQpcDc.approvedYears, approvedYears);
  assert.equal(franceQpcDc.policyAuthorized, true);
  assert.equal(franceQpcDc.executionEnabled, false);
  assert.equal(franceQpcDc.policyVersion, "france-dila-constit-2026-09-v2");
  assert.equal(franceQpcDc.policyReviewDueAt, "2027-03-15");
  assert.deepEqual(franceQpcDc.blocking, []);

  const franceOther = report.tranches[2];
  assert.equal(franceOther.policyAuthorized, false);
  assert.equal(franceOther.executionEnabled, false);
  assert.equal(franceOther.policyVersion, null);
  assert.deepEqual(franceOther.blocking, ["owner_source_policy_not_approved", "deferred_after_qpc_dc"]);

  assert.equal(report.approvedSelectionCount, 32);
  assert.deepEqual(report.approvedSelections[0], {
    sourceKey: "de-bverfg",
    country: "Germany",
    year: 2023,
    documentType: "DECISION",
    policyVersion: "bverfg-unattended-canary-v2",
    policyReviewDueAt: "2027-03-15",
  });
  assert.deepEqual(report.approvedSelections[1], {
    sourceKey: "de-bverfg",
    country: "Germany",
    year: 2024,
    documentType: "DECISION",
    policyVersion: "bverfg-unattended-canary-v2",
    policyReviewDueAt: "2027-03-15",
  });
  const franceSelections = report.approvedSelections.filter((entry) => entry.sourceKey === "fr-conseil-constitutionnel");
  assert.equal(franceSelections.length, 30);
  assert.deepEqual(franceSelections[0], {
    sourceKey: "fr-conseil-constitutionnel",
    country: "France",
    year: 2010,
    documentType: "QPC",
    policyVersion: "france-dila-constit-2026-09-v2",
    policyReviewDueAt: "2027-03-15",
  });
  assert.equal(franceSelections.some((entry) => entry.year === 2024 && entry.documentType === "DC"), true);
  assert.equal(franceSelections.every((entry) => entry.documentType === "QPC" || entry.documentType === "DC"), true);

  assert.equal(report.newlyAuthorizedSelectionCount, 31);
  assert.equal(report.m5ExpansionExecutionReady, false);
  assert.equal(report.tranches.filter((tranche) => !tranche.policyAuthorized).length, 5);
  assert.deepEqual(report.nextApprovalRequired, {
    trancheOrder: 3,
    country: "France",
    sourceKey: "fr-conseil-constitutionnel",
    documentTypes: ["L", "LP", "OTHER_CONSEIL_NATURE"],
    status: "pending_owner_approval",
    blocking: ["owner_source_policy_not_approved", "deferred_after_qpc_dc"],
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

test("Germany 1998-2022 expansion stays unapproved even with the history flag on, while 2023 and 2024 are approved", () => {
  for (const year of [1998, 2010, 2022]) {
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
      { sourceKey: "de-bverfg", year: 2022, documentType: "DECISION" },
      { environment: { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" }, currentYear: 2026 },
    ),
    /case_backfill\.germany_expansion_not_approved/,
  );
  for (const year of [2023, 2024]) {
    const approved = selectCaseBackfillRollout(
      { sourceKey: "de-bverfg", year, documentType: "DECISION" },
      { environment: { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" }, currentYear: 2026 },
    );
    assert.equal(approved.policyAuthorized, true);
    assert.equal(approved.executionEnabled, true);
    assert.equal(approved.errorCode, null);
    assert.doesNotThrow(() => assertCaseBackfillRolloutPreflight(
      { sourceKey: "de-bverfg", year, documentType: "DECISION" },
      { environment: { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" }, currentYear: 2026 },
    ));
  }
});

test("France QPC/DC is policyAuthorized but blocked until the exact history flag is on", () => {
  const qpcNoFlag = selectCaseBackfillRollout(
    { sourceKey: "fr-conseil-constitutionnel", year: 2024, documentType: "QPC" },
    { environment: {}, currentYear: 2026 },
  );
  assert.equal(qpcNoFlag.trancheOrder, 2);
  assert.equal(qpcNoFlag.policyAuthorized, true);
  assert.equal(qpcNoFlag.executionEnabled, false);
  assert.equal(qpcNoFlag.allowed, false);
  assert.equal(qpcNoFlag.errorCode, "case_backfill.france_history_disabled");
  assert.deepEqual(qpcNoFlag.blocking, ["france_history_disabled"]);

  for (const year of [2010, 2020, 2024]) {
    for (const documentType of ["QPC", "DC"]) {
      const enabled = selectCaseBackfillRollout(
        { sourceKey: "fr-conseil-constitutionnel", year, documentType },
        { environment: { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" }, currentYear: 2026 },
      );
      assert.equal(enabled.trancheOrder, 2, `${year} ${documentType}`);
      assert.equal(enabled.policyAuthorized, true);
      assert.equal(enabled.executionEnabled, true);
      assert.equal(enabled.allowed, true);
      assert.equal(enabled.errorCode, null);
    }
  }
});

test("other France Conseil natures stay deferred even with the history flag on", () => {
  const flag = { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" };
  for (const documentType of ["L", "LP", "OTHER_CONSEIL_NATURE"]) {
    const result = selectCaseBackfillRollout(
      { sourceKey: "fr-conseil-constitutionnel", year: 2024, documentType },
      { environment: flag, currentYear: 2026 },
    );
    assert.equal(result.trancheOrder, 3);
    assert.equal(result.policyAuthorized, false);
    assert.equal(result.allowed, false);
    assert.equal(result.errorCode, "case_backfill.france_history_source_policy_not_approved");
    assert.deepEqual(result.blocking, ["owner_source_policy_not_approved", "deferred_after_qpc_dc"]);
  }

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

test("France approval is never an env-only bypass and an explicit unapproved injection still blocks", () => {
  const disabled = selectCaseBackfillRollout(
    { sourceKey: "fr-conseil-constitutionnel", year: 2024, documentType: "QPC" },
    {
      environment: { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" },
      currentYear: 2026,
      franceHistorySourcePolicyApproved: false,
    },
  );
  assert.equal(disabled.policyAuthorized, false);
  assert.equal(disabled.executionEnabled, false);
  assert.equal(disabled.allowed, false);
  assert.equal(disabled.errorCode, "case_backfill.france_history_source_policy_not_approved");

  assert.throws(
    () => assertCaseBackfillRolloutPreflight(
      { sourceKey: "fr-conseil-constitutionnel", year: 2024, documentType: "QPC" },
      {
        environment: { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" },
        currentYear: 2026,
        franceHistorySourcePolicyApproved: false,
      },
    ),
    /case_backfill\.france_history_source_policy_not_approved/,
  );
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
    [{ sourceKey: "de-bverfg", year: 2022, documentType: "DECISION" }, "case_backfill.germany_expansion_not_approved"],
    [{ sourceKey: "fr-conseil-constitutionnel", year: 2024, documentType: "L" }, "case_backfill.france_history_source_policy_not_approved"],
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

test("M5 expansion execution readiness requires an executionEnabled newly approved tranche", () => {
  const off = caseBackfillRolloutReadiness({ environment: {}, currentYear: 2026, now: NOW });
  assert.equal(off.newlyAuthorizedSelectionCount, 31);
  assert.equal(off.m5ExpansionExecutionReady, false);

  const franceOn = caseBackfillRolloutReadiness({
    environment: { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" },
    currentYear: 2026,
    now: NOW,
  });
  assert.equal(franceOn.newlyAuthorizedSelectionCount, 31);
  assert.equal(franceOn.m5ExpansionExecutionReady, true);
  const franceQpcDc = franceOn.tranches[1];
  assert.equal(franceQpcDc.policyAuthorized, true);
  assert.equal(franceQpcDc.executionEnabled, true);
  const franceOther = franceOn.tranches[2];
  assert.equal(franceOther.policyAuthorized, false);
  assert.equal(franceOther.executionEnabled, false);
  assert.equal(
    selectCaseBackfillRollout(
      { sourceKey: "fr-conseil-constitutionnel", year: 2024, documentType: "L" },
      { environment: { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" }, currentYear: 2026 },
    ).allowed,
    false,
  );

  // The Germany 2024 canary alone is the baseline and cannot make M5 expansion
  // ready, but the additive 2023 successor is a newly authorized selection and
  // does make it execution-ready when the Germany history flag is on.
  const germanyOn = caseBackfillRolloutReadiness({
    environment: { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" },
    currentYear: 2026,
    now: NOW,
  });
  assert.equal(germanyOn.newlyAuthorizedSelectionCount, 31);
  assert.equal(germanyOn.m5ExpansionExecutionReady, true);
  const germany = germanyOn.tranches[0];
  assert.deepEqual(germany.approvedYears, [2023, 2024]);
  assert.equal(germany.executionEnabled, true);
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
  policyDependencies: { franceHistorySourcePolicyApproved?: boolean; spainHistorySourcePolicyApproved?: boolean } = {},
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
      ...policyDependencies,
    }),
    pattern,
  );
  assert.equal(began, false, `${snapshot.sourceKey} ${phase} must not create a run`);
}

test("service defense blocks unapproved tranches in non-discover phases before beginRun", async () => {
  await expectNoRun(
    defenseSnapshot({ sourceKey: "de-bverfg", scopeFrom: "2022-01-01", scopeTo: "2022-12-31" }),
    "fetch",
    { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" },
    /case_backfill\.germany_expansion_not_approved/,
  );
  await expectNoRun(
    defenseSnapshot({ sourceKey: "fr-conseil-constitutionnel", scopeFrom: "2024-01-01", scopeTo: "2024-12-31", documentType: "QPC", sourcePolicyVersion: "france-policy-v1" }),
    "fetch",
    { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" },
    /case_backfill\.france_history_source_policy_not_approved/,
    { franceHistorySourcePolicyApproved: false },
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
    defenseSnapshot({ sourceKey: "de-bverfg", scopeFrom: "2022-01-01", scopeTo: "2022-12-31", status: "open" }),
    "discover",
    { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" },
    /case_backfill\.germany_expansion_not_approved/,
  );
  await expectNoRun(
    defenseSnapshot({ sourceKey: "fr-conseil-constitutionnel", scopeFrom: "2024-01-01", scopeTo: "2024-12-31", documentType: "QPC", sourcePolicyVersion: "france-policy-v1", status: "open" }),
    "discover",
    { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" },
    /case_backfill\.france_history_source_policy_not_approved/,
    { franceHistorySourcePolicyApproved: false },
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
