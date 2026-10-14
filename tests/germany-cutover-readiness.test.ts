import assert from "node:assert/strict";
import test from "node:test";
import {
  GERMANY_CUTOVER_GATES,
  evaluateGermanyCutoverReadiness,
  planGermanyCutover,
  type GermanyCutoverGate,
  type GermanyCutoverProof,
} from "../lib/cloudflare/ingest-stages/germany-cutover-readiness";

test("germany cutover readiness rejects a legacy-historical-counts-only proof", () => {
  const countsOnly = { coreArticles: 1430, publishedP3: 583, searchEligible: 582, discovered: 9, fetched: 0 };
  const readiness = evaluateGermanyCutoverReadiness(countsOnly as Partial<GermanyCutoverProof>);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.legacyHistoricalCountsOnly, true);
  assert.equal(readiness.blockers[0], "germany_cutover.legacy_historical_counts_rejected");
  // Aggregate counts must never authorize; the planner emits no mutation.
  const plan = planGermanyCutover(countsOnly as Partial<GermanyCutoverProof>, CURRENT);
  assert.equal(plan.authorized, false);
  assert.equal(plan.plannedAllowlist, "");
  assert.equal(plan.plannedExclude, "");
});

const GATE_FIELD: Record<GermanyCutoverGate, keyof GermanyCutoverProof> = {
  official_ecli_fetched: "officialEcliFetched",
  ecli_identity_exact: "ecliIdentityExact",
  seven_stage_e2e: "sevenStageE2E",
  core_verified_content: "coreVerifiedContent",
  p3_published: "p3Published",
  search_projected: "searchProjected",
};

const FULL_PROOF: GermanyCutoverProof = {
  officialEcliFetched: true,
  ecliIdentityExact: true,
  sevenStageE2E: true,
  coreVerifiedContent: true,
  p3Published: true,
  searchProjected: true,
};

const CURRENT = {
  stagedAllowlist: ["fr-conseil-constitutionnel", "es-tribunal-constitucional"],
  m8Exclude: ["fr-conseil-constitutionnel", "es-tribunal-constitucional"],
};

test("germany cutover readiness fails closed for null/empty/partial proof", () => {
  for (const proof of [null, undefined, {}, { officialEcliFetched: true }]) {
    const readiness = evaluateGermanyCutoverReadiness(proof);
    assert.equal(readiness.ready, false, `expected not ready for ${JSON.stringify(proof)}`);
    assert.ok(readiness.blockers.length > 0);
    assert.ok(readiness.blockers.every((blocker) => blocker.startsWith("germany_cutover.")));
  }
});

test("germany cutover readiness requires every gate explicitly true", () => {
  for (const gate of GERMANY_CUTOVER_GATES) {
    const proof: Record<string, boolean> = { ...FULL_PROOF };
    proof[GATE_FIELD[gate]] = false;
    const readiness = evaluateGermanyCutoverReadiness(proof as Partial<GermanyCutoverProof>);
    assert.equal(readiness.ready, false);
    assert.ok(readiness.blockers.includes(`germany_cutover.${gate}_not_observed`));
  }
});

test("germany cutover readiness passes only for the full observed proof", () => {
  const readiness = evaluateGermanyCutoverReadiness(FULL_PROOF);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.blockers, []);
  assert.equal(readiness.gates.length, GERMANY_CUTOVER_GATES.length);
  assert.ok(readiness.gates.every((gate) => gate.passed && gate.required));
});

test("germany cutover planner refuses a mutation while any proof gate is missing", () => {
  const plan = planGermanyCutover({ officialEcliFetched: true, ecliIdentityExact: true }, CURRENT);
  assert.equal(plan.authorized, false);
  assert.equal(plan.plannedAllowlist, "");
  assert.equal(plan.plannedExclude, "");
  assert.ok(plan.reason?.startsWith("germany_cutover."));
  assert.equal(plan.rollback.allowlist, "fr-conseil-constitutionnel,es-tribunal-constitucional");
  assert.equal(plan.rollback.exclude, "fr-conseil-constitutionnel,es-tribunal-constitucional");
});

test("germany cutover planner emits the exact paired allowlist/exclude on full proof", () => {
  const plan = planGermanyCutover(FULL_PROOF, CURRENT);
  assert.equal(plan.authorized, true);
  assert.equal(plan.plannedAllowlist, "fr-conseil-constitutionnel,es-tribunal-constitucional,de-bverfg");
  assert.equal(plan.plannedExclude, "fr-conseil-constitutionnel,es-tribunal-constitucional,de-bverfg");
  assert.equal(plan.plannedAllowlist, plan.plannedExclude);
  assert.equal(plan.rollback.allowlist, "fr-conseil-constitutionnel,es-tribunal-constitucional");
  assert.equal(plan.rollback.exclude, "fr-conseil-constitutionnel,es-tribunal-constitucional");
});

test("germany cutover planner does not duplicate an already-present source", () => {
  const plan = planGermanyCutover(FULL_PROOF, {
    stagedAllowlist: ["fr-conseil-constitutionnel", "de-bverfg"],
    m8Exclude: ["fr-conseil-constitutionnel", "de-bverfg"],
  });
  assert.equal(plan.authorized, true);
  assert.equal(plan.plannedAllowlist, "fr-conseil-constitutionnel,de-bverfg");
  assert.equal(plan.plannedExclude, "fr-conseil-constitutionnel,de-bverfg");
});

test("germany cutover planner fails closed when current ownership is not exact paired", () => {
  const mismatches = [
    { stagedAllowlist: ["fr-conseil-constitutionnel", "es-tribunal-constitucional"], m8Exclude: ["fr-conseil-constitutionnel"], reason: "germany_cutover.ownership_not_paired_length_mismatch" },
    { stagedAllowlist: ["fr-conseil-constitutionnel", "es-tribunal-constitucional"], m8Exclude: ["es-tribunal-constitucional", "fr-conseil-constitutionnel"], reason: "germany_cutover.ownership_not_paired_order_or_content_mismatch" },
    { stagedAllowlist: ["fr-conseil-constitutionnel", "es-tribunal-constitucional"], m8Exclude: ["fr-conseil-constitutionnel", "us-scotus"], reason: "germany_cutover.ownership_not_paired_order_or_content_mismatch" },
  ];
  for (const mismatch of mismatches) {
    const plan = planGermanyCutover(FULL_PROOF, mismatch as { stagedAllowlist: string[]; m8Exclude: string[] });
    assert.equal(plan.authorized, false, `expected not authorized for ${JSON.stringify(mismatch)}`);
    assert.equal(plan.plannedAllowlist, "");
    assert.equal(plan.plannedExclude, "");
    assert.equal(plan.reason, mismatch.reason);
    assert.equal(plan.rollback.allowlist, mismatch.stagedAllowlist.join(","));
    assert.equal(plan.rollback.exclude, mismatch.m8Exclude.join(","));
  }
});

test("germany cutover planner rejects duplicate or blank current ownership entries", () => {
  const dup = planGermanyCutover(FULL_PROOF, {
    stagedAllowlist: ["fr-conseil-constitutionnel", "fr-conseil-constitutionnel"],
    m8Exclude: ["fr-conseil-constitutionnel", "fr-conseil-constitutionnel"],
  });
  assert.equal(dup.authorized, false);
  assert.equal(dup.reason, "germany_cutover.ownership_not_paired_duplicate_entry");
  const blank = planGermanyCutover(FULL_PROOF, {
    stagedAllowlist: ["fr-conseil-constitutionnel", ""],
    m8Exclude: ["fr-conseil-constitutionnel", ""],
  });
  assert.equal(blank.authorized, false);
  assert.equal(blank.reason, "germany_cutover.ownership_not_paired_empty_entry");
});

test("germany cutover planner authorizes a fully aligned paired list", () => {
  const plan = planGermanyCutover(FULL_PROOF, {
    stagedAllowlist: ["es-tribunal-constitucional", "fr-conseil-constitutionnel"],
    m8Exclude: ["es-tribunal-constitucional", "fr-conseil-constitutionnel"],
  });
  assert.equal(plan.authorized, true);
  assert.equal(plan.plannedAllowlist, "es-tribunal-constitucional,fr-conseil-constitutionnel,de-bverfg");
  assert.equal(plan.plannedExclude, plan.plannedAllowlist);
});
