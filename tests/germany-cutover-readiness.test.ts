import assert from "node:assert/strict";
import test from "node:test";
import {
  GERMANY_CUTOVER_GATES,
  evaluateGermanyCutoverReadiness,
  planGermanyCutover,
  type GermanyCutoverGate,
  type GermanyCutoverProof,
} from "../lib/cloudflare/ingest-stages/germany-cutover-readiness";

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
