import assert from "node:assert/strict";
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

const fixture = `<!doctype html><html><body><table>
  <thead><tr><th>Case Name</th><th>Essay Title and Serial Number</th></tr></thead>
  <tbody>
    <tr>
      <td>Baker v. Carr, 369 U.S. 186 (1962)</td>
      <td><a href="/browse/essay/artI-S2-C1-1/ALDE_00001001/">Congressional Districting</a></td>
    </tr>
    <tr>
      <td>Baker v. Carr, 369 U.S. 186 (1962)</td>
      <td><a href="https://constitution.congress.gov/browse/essay/amdt14-S1-8-1/ALDE_00000815/">Equal Protection</a></td>
    </tr>
    <tr>
      <td>Example District Case, 103 F. Supp. 569 (D.D.C. 1952)</td>
      <td><a href="/browse/essay/artIII-S2-C1-1/ALDE_00000069/">Methodology</a></td>
    </tr>
  </tbody>
</table></body></html>`;

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
