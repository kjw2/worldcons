import assert from "node:assert/strict";
import test from "node:test";
import {
  US_CUTOVER_GATES,
  US_LEGACY_HISTORICAL_FIELDS,
  US_MANUAL_APPROVAL_DOCUMENT_SCHEMA,
  US_MANUAL_APPROVAL_POLICY,
  evaluateSameCaseManualApprovalReceipt,
  evaluateUsCutoverReadiness,
  planUsCutover,
  type UsCutoverGate,
  type UsCutoverProof,
  type UsManualApprovalAssessment,
} from "../lib/cloudflare/ingest-stages/us-cutover-readiness";

const RECEIPT: UsManualApprovalAssessment = {
  present: true,
  authenticated: true,
  reason: "us_manual_approval.same_case_snapshot_bound_human_receipt",
  actorId: "reviewer:external",
  policyVersion: US_MANUAL_APPROVAL_POLICY,
};

/** A `planUsCutover` invocation carrying the mandatory same-case human receipt. */
function planWithReceipt(
  proof: Partial<UsCutoverProof> | null | undefined,
  current: { stagedAllowlist: string[]; m8Exclude: string[] },
) {
  return planUsCutover(proof, current, { manualApprovalReceipt: RECEIPT });
}

const GATE_FIELD: Record<UsCutoverGate, keyof UsCutoverProof> = {
  official_pdf_fetched: "officialPdfFetched",
  docket_identity_verified: "docketIdentityVerified",
  r2_original_bytes: "r2OriginalBytes",
  core_provenance: "coreProvenance",
  private_review_hold: "privateReviewHold",
  staged_e2e: "stagedE2E",
  manual_publication_authorization: "manualPublicationAuthorization",
  p3_published: "p3Published",
  search_projected: "searchProjected",
};

const FULL_PROOF: UsCutoverProof = {
  officialPdfFetched: true,
  docketIdentityVerified: true,
  r2OriginalBytes: true,
  coreProvenance: true,
  privateReviewHold: true,
  stagedE2E: true,
  manualPublicationAuthorization: true,
  p3Published: true,
  searchProjected: true,
};

const CURRENT = {
  stagedAllowlist: ["fr-conseil-constitutionnel", "es-tribunal-constitucional"],
  m8Exclude: ["fr-conseil-constitutionnel", "es-tribunal-constitucional"],
};

test("US cutover readiness fails closed for null/empty/partial proof", () => {
  for (const proof of [null, undefined, {}, { officialPdfFetched: true }]) {
    const readiness = evaluateUsCutoverReadiness(proof);
    assert.equal(readiness.ready, false, `expected not ready for ${JSON.stringify(proof)}`);
    assert.ok(readiness.blockers.length > 0);
    assert.ok(readiness.blockers.every((blocker) => blocker.startsWith("us_cutover.")));
  }
});

test("US cutover readiness requires every gate explicitly true", () => {
  for (const gate of US_CUTOVER_GATES) {
    const proof: Record<string, boolean> = { ...FULL_PROOF };
    proof[GATE_FIELD[gate]] = false;
    const readiness = evaluateUsCutoverReadiness(proof as Partial<UsCutoverProof>);
    assert.equal(readiness.ready, false);
    assert.ok(readiness.blockers.includes(`us_cutover.${gate}_not_observed`));
  }
});

test("US cutover readiness passes only for the full observed proof", () => {
  const readiness = evaluateUsCutoverReadiness(FULL_PROOF);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.blockers, []);
  assert.equal(readiness.gates.length, US_CUTOVER_GATES.length);
  assert.ok(readiness.gates.every((gate) => gate.passed && gate.required));
  assert.equal(readiness.legacyHistoricalCountsOnly, false);
});

test("US cutover readiness rejects a proof made only of legacy historical counts", () => {
  const proof = { coreArticles: 136, publishedP3: 136, searchEligible: 136, discovered: 0, fetched: 0 };
  const readiness = evaluateUsCutoverReadiness(proof as Partial<UsCutoverProof>);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.legacyHistoricalCountsOnly, true);
  assert.ok(readiness.blockers.includes("us_cutover.legacy_historical_counts_rejected"));
  for (const field of US_LEGACY_HISTORICAL_FIELDS) {
    assert.equal(typeof (proof as Record<string, unknown>)[field], "number");
  }
});

test("US cutover planner refuses a mutation without a same-case human approval receipt", () => {
  // A caller-supplied boolean is NOT sufficient; the immutable receipt is required.
  const plan = planUsCutover(FULL_PROOF, CURRENT);
  assert.equal(plan.authorized, false);
  assert.equal(plan.plannedAllowlist, "");
  assert.equal(plan.plannedExclude, "");
  assert.equal(plan.reason, "us_cutover.manual_approval_receipt_not_observed");
  assert.equal(plan.rollback.allowlist, "fr-conseil-constitutionnel,es-tribunal-constitucional");
  assert.equal(plan.rollback.exclude, "fr-conseil-constitutionnel,es-tribunal-constitucional");
  // The absence of the `manual_publication_authorization` proof gate still wins first.
  const withoutManual: Partial<UsCutoverProof> = { ...FULL_PROOF };
  delete withoutManual.manualPublicationAuthorization;
  const missingGate = planWithReceipt(withoutManual, CURRENT);
  assert.equal(missingGate.authorized, false);
  assert.equal(missingGate.reason, "us_cutover.manual_publication_authorization_not_observed");
});

test("US cutover planner refuses a mutation while any proof gate is missing", () => {
  const plan = planWithReceipt({ officialPdfFetched: true, docketIdentityVerified: true }, CURRENT);
  assert.equal(plan.authorized, false);
  assert.equal(plan.plannedAllowlist, "");
  assert.equal(plan.plannedExclude, "");
  assert.ok(plan.reason?.startsWith("us_cutover."));
  assert.equal(plan.rollback.allowlist, "fr-conseil-constitutionnel,es-tribunal-constitucional");
  assert.equal(plan.rollback.exclude, "fr-conseil-constitutionnel,es-tribunal-constitucional");
});

test("US cutover planner emits the exact paired allowlist/exclude on full proof with a same-case receipt", () => {
  const plan = planWithReceipt(FULL_PROOF, CURRENT);
  assert.equal(plan.authorized, true);
  assert.equal(plan.plannedAllowlist, "fr-conseil-constitutionnel,es-tribunal-constitucional,us-scotus");
  assert.equal(plan.plannedExclude, "fr-conseil-constitutionnel,es-tribunal-constitucional,us-scotus");
  assert.equal(plan.plannedAllowlist, plan.plannedExclude);
  assert.equal(plan.rollback.allowlist, "fr-conseil-constitutionnel,es-tribunal-constitucional");
  assert.equal(plan.rollback.exclude, "fr-conseil-constitutionnel,es-tribunal-constitucional");
});

test("US cutover planner does not duplicate an already-present source", () => {
  const plan = planWithReceipt(FULL_PROOF, {
    stagedAllowlist: ["fr-conseil-constitutionnel", "us-scotus"],
    m8Exclude: ["fr-conseil-constitutionnel", "us-scotus"],
  });
  assert.equal(plan.authorized, true);
  assert.equal(plan.plannedAllowlist, "fr-conseil-constitutionnel,us-scotus");
  assert.equal(plan.plannedExclude, "fr-conseil-constitutionnel,us-scotus");
});

test("US cutover planner never authorizes on legacy historical counts alone", () => {
  const plan = planWithReceipt(
    { coreArticles: 136, publishedP3: 136, searchEligible: 136 } as Partial<UsCutoverProof>,
    CURRENT,
  );
  assert.equal(plan.authorized, false);
  assert.equal(plan.reason, "us_cutover.legacy_historical_counts_rejected");
});

test("US cutover planner fails closed when current ownership is not exact paired", () => {
  const mismatches = [
    { stagedAllowlist: ["fr-conseil-constitutionnel", "es-tribunal-constitucional"], m8Exclude: ["fr-conseil-constitutionnel"], reason: "us_cutover.ownership_not_paired_length_mismatch" },
    { stagedAllowlist: ["fr-conseil-constitutionnel", "es-tribunal-constitucional"], m8Exclude: ["es-tribunal-constitucional", "fr-conseil-constitutionnel"], reason: "us_cutover.ownership_not_paired_order_or_content_mismatch" },
    { stagedAllowlist: ["fr-conseil-constitutionnel", "es-tribunal-constitucional"], m8Exclude: ["fr-conseil-constitutionnel", "de-bverfg"], reason: "us_cutover.ownership_not_paired_order_or_content_mismatch" },
  ];
  for (const mismatch of mismatches) {
    const plan = planWithReceipt(FULL_PROOF, mismatch as { stagedAllowlist: string[]; m8Exclude: string[] });
    assert.equal(plan.authorized, false, `expected not authorized for ${JSON.stringify(mismatch)}`);
    assert.equal(plan.plannedAllowlist, "");
    assert.equal(plan.plannedExclude, "");
    assert.equal(plan.reason, mismatch.reason);
    assert.equal(plan.rollback.allowlist, mismatch.stagedAllowlist.join(","));
    assert.equal(plan.rollback.exclude, mismatch.m8Exclude.join(","));
  }
});

test("US cutover planner rejects duplicate or blank current ownership entries", () => {
  const dup = planWithReceipt(FULL_PROOF, {
    stagedAllowlist: ["fr-conseil-constitutionnel", "fr-conseil-constitutionnel"],
    m8Exclude: ["fr-conseil-constitutionnel", "fr-conseil-constitutionnel"],
  });
  assert.equal(dup.authorized, false);
  assert.equal(dup.reason, "us_cutover.ownership_not_paired_duplicate_entry");
  const blank = planWithReceipt(FULL_PROOF, {
    stagedAllowlist: ["fr-conseil-constitutionnel", ""],
    m8Exclude: ["fr-conseil-constitutionnel", ""],
  });
  assert.equal(blank.authorized, false);
  assert.equal(blank.reason, "us_cutover.ownership_not_paired_empty_entry");
});

test("US cutover planner authorizes a fully aligned paired list with a same-case receipt", () => {
  const aligned = planWithReceipt(FULL_PROOF, {
    stagedAllowlist: ["es-tribunal-constitucional", "fr-conseil-constitutionnel"],
    m8Exclude: ["es-tribunal-constitucional", "fr-conseil-constitutionnel"],
  });
  assert.equal(aligned.authorized, true);
  assert.equal(aligned.plannedAllowlist, "es-tribunal-constitucional,fr-conseil-constitutionnel,us-scotus");
  assert.equal(aligned.plannedExclude, aligned.plannedAllowlist);
  const emptyAligned = planWithReceipt(FULL_PROOF, { stagedAllowlist: [], m8Exclude: [] });
  assert.equal(emptyAligned.authorized, true);
  assert.equal(emptyAligned.plannedAllowlist, "us-scotus");
  assert.equal(emptyAligned.plannedExclude, "us-scotus");
});

test("same-case manual approval receipt: only immutable human receipts with a real actor count", () => {
  const CORE = "4b3d5644-2681-449e-8ad5-28ee2defffe8";
  const humanDocument = JSON.stringify({ schema: US_MANUAL_APPROVAL_DOCUMENT_SCHEMA, actorId: "ops:reviewer", policyVersion: US_MANUAL_APPROVAL_POLICY });
  const present = evaluateSameCaseManualApprovalReceipt(CORE, [
    { articleId: CORE, policyVersion: US_MANUAL_APPROVAL_POLICY, evidenceDocument: humanDocument },
  ]);
  assert.equal(present.present, true);
  assert.equal(present.actorId, "ops:reviewer");

  const cases: Array<[string, Array<{ articleId: string; policyVersion: string; evidenceDocument: string }>]> = [
    ["different article", [{ articleId: "other", policyVersion: US_MANUAL_APPROVAL_POLICY, evidenceDocument: humanDocument }]],
    ["automatic FR/ES ledger is not manual", [{ articleId: CORE, policyVersion: "worldcons.fr-es-staged-approval.v1", evidenceDocument: humanDocument }]],
    ["missing actor", [{ articleId: CORE, policyVersion: US_MANUAL_APPROVAL_POLICY, evidenceDocument: JSON.stringify({ schema: US_MANUAL_APPROVAL_DOCUMENT_SCHEMA, actorId: "" }) }]],
    ["wrong document schema", [{ articleId: CORE, policyVersion: US_MANUAL_APPROVAL_POLICY, evidenceDocument: JSON.stringify({ schema: "worldcons.removal-authority.v1", actorId: "x" }) }]],
    ["malformed document", [{ articleId: CORE, policyVersion: US_MANUAL_APPROVAL_POLICY, evidenceDocument: "not-json" }]],
  ];
  for (const [name, rows] of cases) {
    assert.equal(evaluateSameCaseManualApprovalReceipt(CORE, rows).present, false, name);
  }
  assert.equal(evaluateSameCaseManualApprovalReceipt(null, []).present, false);
});

test("same-case manual approval receipt: synthetic policy/schema/actor is present but NOT authenticated without current-state binding", () => {
  const CORE = "4b3d5644-2681-449e-8ad5-28ee2defffe8";
  const SNAP = "a".repeat(64);
  const SRC = "b".repeat(64);
  const document = JSON.stringify({ schema: US_MANUAL_APPROVAL_DOCUMENT_SCHEMA, actorId: "ops:forged", approvalSnapshotHash: SNAP, sourceContentHash: SRC });
  const rows = [{ articleId: CORE, policyVersion: US_MANUAL_APPROVAL_POLICY, evidenceDocument: document, approvalSnapshotHash: SNAP, sourceContentHash: SRC }];
  // Without an expectation, only `present` may be claimed; never `authenticated`.
  const unbound = evaluateSameCaseManualApprovalReceipt(CORE, rows);
  assert.equal(unbound.present, true);
  assert.equal(unbound.authenticated, false);
  assert.equal(unbound.reason, "us_manual_approval.receipt_present_unauthenticated");
  // With an expectation that disagrees, it fails closed.
  const mismatch = evaluateSameCaseManualApprovalReceipt(CORE, rows, {
    currentApprovalSnapshotHash: "c".repeat(64),
    currentSourceContentHash: SRC,
    officialPdf: { docketVerified: true, sha256: "1".repeat(64), r2Key: "artifacts/scotus_pdf/x.pdf", url: "https://www.supremecourt.gov/opinions/25pdf/26a388_q86b.pdf" },
  });
  assert.equal(mismatch.present, true);
  assert.equal(mismatch.authenticated, false);
  assert.equal(mismatch.reason, "us_manual_approval.receipt_snapshot_mismatch");
  // A legacy US row with no verified official-PDF proof can never authenticate,
  // even if the snapshot hashes happen to match.
  const noPdf = evaluateSameCaseManualApprovalReceipt(CORE, rows, {
    currentApprovalSnapshotHash: SNAP,
    currentSourceContentHash: SRC,
    officialPdf: { docketVerified: false, sha256: null, r2Key: null, url: null },
  });
  assert.equal(noPdf.authenticated, false);
  // Only a fully bound receipt authenticates.
  const bound = evaluateSameCaseManualApprovalReceipt(CORE, rows, {
    currentApprovalSnapshotHash: SNAP,
    currentSourceContentHash: SRC,
    officialPdf: { docketVerified: true, sha256: "1".repeat(64), r2Key: "artifacts/scotus_pdf/x.pdf", url: "https://www.supremecourt.gov/opinions/25pdf/26a388_q86b.pdf" },
  });
  assert.equal(bound.present, true);
  assert.equal(bound.authenticated, true);
  assert.equal(bound.reason, "us_manual_approval.same_case_snapshot_bound_human_receipt");
});

test("same-case manual approval receipt: a MISSING binding hash (document or ledger) fails closed and can never widen the gate", () => {
  const CORE = "4b3d5644-2681-449e-8ad5-28ee2defffe8";
  const SNAP = "a".repeat(64);
  const SRC = "b".repeat(64);
  const expectation = {
    currentApprovalSnapshotHash: SNAP,
    currentSourceContentHash: SRC,
    officialPdf: { docketVerified: true, sha256: "1".repeat(64), r2Key: "artifacts/scotus_pdf/x.pdf", url: "https://www.supremecourt.gov/opinions/25pdf/26a388_q86b.pdf" },
  };
  // (a) Document omits BOTH hashes — never authenticates.
  const missingBoth = evaluateSameCaseManualApprovalReceipt(CORE, [
    { articleId: CORE, policyVersion: US_MANUAL_APPROVAL_POLICY, evidenceDocument: JSON.stringify({ schema: US_MANUAL_APPROVAL_DOCUMENT_SCHEMA, actorId: "ops:x" }), approvalSnapshotHash: SNAP, sourceContentHash: SRC },
  ], expectation);
  assert.equal(missingBoth.present, true);
  assert.equal(missingBoth.authenticated, false);
  // (b) Document omits only sourceContentHash — never authenticates.
  const missingDocSource = evaluateSameCaseManualApprovalReceipt(CORE, [
    { articleId: CORE, policyVersion: US_MANUAL_APPROVAL_POLICY, evidenceDocument: JSON.stringify({ schema: US_MANUAL_APPROVAL_DOCUMENT_SCHEMA, actorId: "ops:x", approvalSnapshotHash: SNAP }), approvalSnapshotHash: SNAP, sourceContentHash: SRC },
  ], expectation);
  assert.equal(missingDocSource.authenticated, false);
  // (c) Document omits only approvalSnapshotHash — never authenticates.
  const missingDocSnapshot = evaluateSameCaseManualApprovalReceipt(CORE, [
    { articleId: CORE, policyVersion: US_MANUAL_APPROVAL_POLICY, evidenceDocument: JSON.stringify({ schema: US_MANUAL_APPROVAL_DOCUMENT_SCHEMA, actorId: "ops:x", sourceContentHash: SRC }), approvalSnapshotHash: SNAP, sourceContentHash: SRC },
  ], expectation);
  assert.equal(missingDocSnapshot.authenticated, false);
  // (d) Ledger row omits sourceContentHash (empty) — never authenticates.
  const missingLedgerSource = evaluateSameCaseManualApprovalReceipt(CORE, [
    { articleId: CORE, policyVersion: US_MANUAL_APPROVAL_POLICY, evidenceDocument: JSON.stringify({ schema: US_MANUAL_APPROVAL_DOCUMENT_SCHEMA, actorId: "ops:x", approvalSnapshotHash: SNAP, sourceContentHash: SRC }), approvalSnapshotHash: SNAP, sourceContentHash: "" },
  ], expectation);
  assert.equal(missingLedgerSource.authenticated, false);
  // (e) Ledger row omits approvalSnapshotHash — never authenticates.
  const missingLedgerSnapshot = evaluateSameCaseManualApprovalReceipt(CORE, [
    { articleId: CORE, policyVersion: US_MANUAL_APPROVAL_POLICY, evidenceDocument: JSON.stringify({ schema: US_MANUAL_APPROVAL_DOCUMENT_SCHEMA, actorId: "ops:x", approvalSnapshotHash: SNAP, sourceContentHash: SRC }), approvalSnapshotHash: null, sourceContentHash: SRC },
  ], expectation);
  assert.equal(missingLedgerSnapshot.authenticated, false);
  // (f) Empty expectation anchors must never authenticate either.
  const emptyExpectation = evaluateSameCaseManualApprovalReceipt(CORE, [
    { articleId: CORE, policyVersion: US_MANUAL_APPROVAL_POLICY, evidenceDocument: JSON.stringify({ schema: US_MANUAL_APPROVAL_DOCUMENT_SCHEMA, actorId: "ops:x", approvalSnapshotHash: "", sourceContentHash: "" }), approvalSnapshotHash: "", sourceContentHash: "" },
  ], { currentApprovalSnapshotHash: "", currentSourceContentHash: "", officialPdf: expectation.officialPdf });
  assert.equal(emptyExpectation.authenticated, false);
  // Control: the fully-present, exactly-matching receipt still authenticates.
  const bound = evaluateSameCaseManualApprovalReceipt(CORE, [
    { articleId: CORE, policyVersion: US_MANUAL_APPROVAL_POLICY, evidenceDocument: JSON.stringify({ schema: US_MANUAL_APPROVAL_DOCUMENT_SCHEMA, actorId: "ops:x", approvalSnapshotHash: SNAP, sourceContentHash: SRC }), approvalSnapshotHash: SNAP, sourceContentHash: SRC },
  ], expectation);
  assert.equal(bound.authenticated, true);
});
