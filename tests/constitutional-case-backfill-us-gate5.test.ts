import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  US_CONSTITUTION_ANNOTATED_FLAG,
  applyConstitutionAnnotatedPriority,
  classifyUsCaseCitation,
  constitutionAnnotatedDiscoveryEnabled,
  isConstitutionAnnotatedChallengePage,
  parseConstitutionAnnotatedCasesHtml,
  verifyConstitutionAnnotatedCandidate,
} from "../lib/backfill/us-constitution-annotated";
import { importUsConanCandidateGraph } from "../lib/backfill/us-conan-import";
import type { UsConanCandidateRepository } from "../lib/backfill/us-conan-repository";

const fixture = fs.readFileSync(
  path.join(process.cwd(), "tests/fixtures/us-conan-table-contract.html"),
  "utf8",
);

test("Constitution Annotated discovery is disabled unless explicitly enabled", () => {
  assert.equal(constitutionAnnotatedDiscoveryEnabled({}), false);
  assert.equal(constitutionAnnotatedDiscoveryEnabled({ [US_CONSTITUTION_ANNOTATED_FLAG]: "true" }), true);
  assert.equal(constitutionAnnotatedDiscoveryEnabled({ [US_CONSTITUTION_ANNOTATED_FLAG]: "1" }), false);
});

test("Table parser deduplicates citations, preserves essay provenance, and never auto-verifies", () => {
  const candidates = parseConstitutionAnnotatedCasesHtml(fixture);
  assert.equal(candidates.length, 2);
  const baker = candidates.find((candidate) => candidate.citation === "369 U.S. 186 (1962)");
  assert.ok(baker);
  assert.equal(baker.caseName, "Baker v. Carr");
  assert.equal(baker.courtClassification, "scotus_candidate");
  assert.equal(baker.constitutionalRelevanceStatus, "candidate");
  assert.deepEqual(baker.essayReferences.map((reference) => reference.essayId), ["ALDE_00001001", "ALDE_00000815"]);
  const district = candidates.find((candidate) => candidate.citation.startsWith("103 F. Supp."));
  assert.equal(district?.courtClassification, "lower_federal");
  assert.equal(district?.constitutionalRelevanceStatus, "candidate");
});

test("reporter classification treats U.S. Reports as a candidate hint, not proof", () => {
  assert.equal(classifyUsCaseCitation("5 U.S. (1 Cranch) 137 (1803)"), "scotus_candidate");
  assert.equal(classifyUsCaseCitation("103 F. Supp. 569 (D.D.C. 1952)"), "lower_federal");
  assert.equal(classifyUsCaseCitation("139 S. Ct. 2484 (2019)"), "unknown");
});

test("verification requires identity, essay context, official authority, and constitutional holding", () => {
  const baker = parseConstitutionAnnotatedCasesHtml(fixture).find((candidate) => candidate.citation.startsWith("369 U.S."));
  assert.ok(baker);
  assert.deepEqual(verifyConstitutionAnnotatedCandidate(baker, {
    officialScotusIdentityVerified: true,
    constitutionalEssayContextVerified: false,
    officialAuthorityVerified: true,
    constitutionalHoldingVerified: true,
  }), { status: "uncertain", blocking: ["constitutional_essay_context_required"] });
  assert.deepEqual(verifyConstitutionAnnotatedCandidate(baker, {
    officialScotusIdentityVerified: true,
    constitutionalEssayContextVerified: true,
    officialAuthorityVerified: true,
    constitutionalHoldingVerified: true,
  }), { status: "verified", blocking: [] });
});

test("lower-court citations cannot be promoted even when evidence flags are incorrectly true", () => {
  const district = parseConstitutionAnnotatedCasesHtml(fixture).find((candidate) => candidate.citation.startsWith("103 F. Supp."));
  assert.ok(district);
  assert.deepEqual(verifyConstitutionAnnotatedCandidate(district, {
    officialScotusIdentityVerified: true,
    constitutionalEssayContextVerified: true,
    officialAuthorityVerified: true,
    constitutionalHoldingVerified: true,
  }), { status: "rejected", blocking: ["not_verified_scotus_identity"] });
});

test("landmark priority changes scheduling only and never changes candidate status", () => {
  const baker = parseConstitutionAnnotatedCasesHtml(fixture).find((candidate) => candidate.citation.startsWith("369 U.S."));
  assert.ok(baker);
  const prioritized = applyConstitutionAnnotatedPriority(baker, new Set(["369 U.S. 186 (1962)"]));
  assert.equal(prioritized.priority, 100);
  assert.deepEqual(prioritized.priorityReasons, ["reviewed_redistricting_landmark_seed"]);
  assert.equal(prioritized.constitutionalRelevanceStatus, "candidate");
});

test("Cloudflare challenge is an unavailable source, not an empty inventory", () => {
  const challenge = "<html><head><title>Just a moment...</title></head><body><div id=cf-chl-widget></div></body></html>";
  assert.equal(isConstitutionAnnotatedChallengePage(challenge), true);
  assert.throws(() => parseConstitutionAnnotatedCasesHtml(challenge), /us_conan\.source_challenge/);
  assert.throws(() => parseConstitutionAnnotatedCasesHtml("<html><body>maintenance</body></html>"), /inventory_empty_or_unrecognized/);
});

function importInput(execute: boolean) {
  return {
    html: fixture,
    payloadHash: "a".repeat(64),
    parserVersion: "us-conan-table-v1",
    observedAt: new Date(Date.now() - 1_000).toISOString(),
    sourcePolicyVersion: execute ? "us-conan-reviewed-v1" : null,
    createdBy: "unit-test",
    execute,
    priorityCitations: new Set(["369 U.S. 186 (1962)"]),
  };
}

test("candidate import plans without database writes or an enabled operational flag", async () => {
  let calls = 0;
  const repository: UsConanCandidateRepository = {
    openSnapshot: async () => { calls += 1; return { snapshotId: "unused", status: "open", candidateCount: 0, manifestHash: null }; },
    upsertCandidate: async () => { calls += 1; return "unused"; },
    closeSnapshot: async () => { calls += 1; throw new Error("unused"); },
  };
  const result = await importUsConanCandidateGraph(importInput(false), { repository, environment: {} });
  assert.equal(result.mode, "plan");
  assert.equal(result.candidateCount, 2);
  assert.deepEqual(result.classifications, {
    scotus_candidate: 1,
    lower_federal: 1,
    state_or_other: 0,
    unknown: 0,
  });
  assert.equal(result.prioritizedCount, 1);
  assert.equal(result.snapshot, null);
  assert.equal(calls, 0);
});

test("candidate import requires both execute and the explicit operational flag", async () => {
  let opened = false;
  const repository: UsConanCandidateRepository = {
    openSnapshot: async () => {
      opened = true;
      return { snapshotId: "snapshot", status: "open", candidateCount: 0, manifestHash: null };
    },
    upsertCandidate: async () => "candidate",
    closeSnapshot: async () => ({ snapshotId: "snapshot", candidateCount: 2, manifestHash: "b".repeat(64) }),
  };
  await assert.rejects(
    importUsConanCandidateGraph(importInput(true), { repository, environment: {} }),
    /case_backfill\.us_conan_disabled/,
  );
  assert.equal(opened, false);
});

test("enabled candidate import persists every parsed candidate then closes the exact manifest", async () => {
  const writes: string[] = [];
  const repository: UsConanCandidateRepository = {
    openSnapshot: async (input) => {
      assert.equal(input.captureMode, "reviewed_fixture");
      assert.equal(input.citationCoverageAssurance, "best_effort");
      assert.equal(input.sourcePolicyVersion, "us-conan-reviewed-v1");
      return { snapshotId: "snapshot-1", status: "open", candidateCount: 0, manifestHash: null };
    },
    upsertCandidate: async (snapshotId, candidate) => {
      assert.equal(snapshotId, "snapshot-1");
      writes.push(candidate.citation);
      assert.equal(candidate.constitutionalRelevanceStatus, "candidate");
      return `candidate-${writes.length}`;
    },
    closeSnapshot: async (snapshotId) => ({
      snapshotId,
      candidateCount: writes.length,
      manifestHash: "b".repeat(64),
    }),
  };
  const result = await importUsConanCandidateGraph(importInput(true), {
    repository,
    environment: { [US_CONSTITUTION_ANNOTATED_FLAG]: "true" },
  });
  assert.equal(result.mode, "imported");
  assert.deepEqual(writes, ["103 F. Supp. 569 (D.D.C. 1952)", "369 U.S. 186 (1962)"]);
  assert.deepEqual(result.snapshot, {
    snapshotId: "snapshot-1",
    candidateCount: 2,
    manifestHash: "b".repeat(64),
  });
});

test("rerunning an already closed identical payload succeeds without manifest writes", async () => {
  let writes = 0;
  const repository: UsConanCandidateRepository = {
    openSnapshot: async () => ({
      snapshotId: "snapshot-closed",
      status: "closed",
      candidateCount: 2,
      manifestHash: "c".repeat(64),
    }),
    upsertCandidate: async () => { writes += 1; return "unused"; },
    closeSnapshot: async () => { writes += 1; throw new Error("unused"); },
  };
  const result = await importUsConanCandidateGraph(importInput(true), {
    repository,
    environment: { [US_CONSTITUTION_ANNOTATED_FLAG]: "true" },
  });
  assert.equal(result.mode, "imported");
  assert.equal(result.snapshot?.snapshotId, "snapshot-closed");
  assert.equal(writes, 0);
});
