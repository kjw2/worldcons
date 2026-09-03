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
import {
  govInfoUsReportsUrls,
  parseGovInfoUsReportsDetails,
  parseUsReportsCitation,
  resolveGovInfoUsReportsAuthority,
} from "../lib/crawlee/us-govinfo-reports-resolver";
import {
  REVIEWED_US_REDISTRICTING_LANDMARKS,
  REVIEWED_US_REDISTRICTING_PRIORITY_CITATIONS,
} from "../lib/backfill/us-redistricting-landmarks";
import {
  GOVINFO_US_REPORTS_RESOLVER_VERSION,
  resolveUsConanCandidateAuthority,
} from "../lib/backfill/us-conan-authority-service";
import type { UsConanAuthorityRepository } from "../lib/backfill/us-conan-authority-repository";
import {
  US_CONAN_REVIEW_FLAG,
  inspectUsConanCandidateReview,
  reviewUsConanCandidate,
} from "../lib/backfill/us-conan-review-service";
import type {
  StoredUsConanReviewContext,
  UsConanReviewRepository,
} from "../lib/backfill/us-conan-review-repository";
import {
  US_CONAN_CATALOG_PUBLISH_FLAG,
  planUsConanCatalogPublication,
  publishUsConanCatalogCandidate,
} from "../lib/backfill/us-conan-catalog-service";
import type {
  UsConanCatalogPublicationContext,
  UsConanCatalogRepository,
  UsConanCatalogSourcePolicy,
} from "../lib/backfill/us-conan-catalog-repository";

const fixture = fs.readFileSync(
  path.join(process.cwd(), "tests/fixtures/us-conan-table-contract.html"),
  "utf8",
);
const govInfoFixture = fs.readFileSync(
  path.join(process.cwd(), "tests/fixtures/us-govinfo-baker-details-contract.html"),
  "utf8",
);
const usCatalogMigration = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260903173000_constitutional_case_us_catalog_gate5.sql"),
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

test("reviewed redistricting seeds have official granule provenance but remain priority-only candidates", () => {
  assert.equal(REVIEWED_US_REDISTRICTING_LANDMARKS.length, 5);
  for (const landmark of REVIEWED_US_REDISTRICTING_LANDMARKS) {
    assert.equal(REVIEWED_US_REDISTRICTING_PRIORITY_CITATIONS.has(landmark.citation), true);
    assert.equal(landmark.priority, 100);
    assert.equal(landmark.priorityOnly, true);
    assert.equal(landmark.constitutionalRelevanceStatus, "candidate");
    const citation = parseUsReportsCitation(landmark.citation);
    assert.ok(citation);
    assert.equal(landmark.officialAuthorityUrl, govInfoUsReportsUrls(citation).detailsUrl);
  }
});

test("Cloudflare challenge is an unavailable source, not an empty inventory", () => {
  const challenge = "<html><head><title>Just a moment...</title></head><body><div id=cf-chl-widget></div></body></html>";
  assert.equal(isConstitutionAnnotatedChallengePage(challenge), true);
  assert.throws(() => parseConstitutionAnnotatedCasesHtml(challenge), /us_conan\.source_challenge/);
  assert.throws(() => parseConstitutionAnnotatedCasesHtml("<html><body>maintenance</body></html>"), /inventory_empty_or_unrecognized/);
});

test("US Catalog bridge revalidates current evidence and remains metadata-only", () => {
  assert.match(usCatalogMigration, /us_conan_candidate_publish_catalog_v1/u);
  assert.match(usCatalogMigration, /US_CONAN_CATALOG_REVIEW_STALE/u);
  assert.match(usCatalogMigration, /US_CONAN_CATALOG_CURRENT_AUTHORITY_REQUIRED/u);
  assert.match(usCatalogMigration, /us_conan_candidate_authority_current_v1/u);
  assert.match(usCatalogMigration, /source_key = 'us-scotus'/u);
  assert.match(usCatalogMigration, /source_key = v_candidate_snapshot\.source_key/u);
  assert.match(usCatalogMigration, /default_text_access_policy not in \('metadata_only', 'index_only'\)/u);
  assert.match(usCatalogMigration, /article_version_capture_v4/u);
  assert.match(usCatalogMigration, /'authoritative_source'/u);
  assert.match(usCatalogMigration, /'cleanedText',''/u);
  assert.match(usCatalogMigration, /case_catalog_publication_events_v1\(publication_id, publication_revision\)/u);
  assert.match(usCatalogMigration, /enable row level security/u);
  assert.match(usCatalogMigration, /revoke all on function us_conan_candidate_publish_catalog_v1/u);
  assert.doesNotMatch(usCatalogMigration, /gemini|summary_json\s*=/iu);
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

test("built-in reviewed landmark set raises priority without an external seed file", async () => {
  const input = importInput(false);
  input.priorityCitations = new Set();
  const result = await importUsConanCandidateGraph(input, { environment: {} });
  const baker = result.candidates.find((candidate) => candidate.citation === "369 U.S. 186 (1962)");
  assert.equal(baker?.priority, 100);
  assert.equal(baker?.constitutionalRelevanceStatus, "candidate");
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

test("U.S. Reports citation maps to the predictable GovInfo granule without proving identity by itself", () => {
  assert.deepEqual(parseUsReportsCitation("369 U.S. 186 (1962)"), {
    volume: 369,
    page: 186,
    year: 1962,
    normalizedCitation: "369 U.S. 186 (1962)",
  });
  assert.deepEqual(parseUsReportsCitation("5 U.S. (1 Cranch) 137 (1803)"), {
    volume: 5,
    page: 137,
    year: 1803,
    normalizedCitation: "5 U.S. (1 Cranch) 137 (1803)",
  });
  assert.deepEqual(govInfoUsReportsUrls({ volume: 369, page: 186 }), {
    detailsUrl: "https://www.govinfo.gov/app/details/USREPORTS-369/USREPORTS-369-186",
    pdfUrl: "https://www.govinfo.gov/content/pkg/USREPORTS-369/pdf/USREPORTS-369-186.pdf",
  });
});

test("GovInfo details parser binds exact citation, party anchors, and official granule PDF", () => {
  const result = parseGovInfoUsReportsDetails(govInfoFixture, {
    caseName: "Baker v. Carr",
    citation: "369 U.S. 186 (1962)",
  });
  assert.equal(result.status, "verified");
  assert.equal(result.officialCaseName, "Baker et al. v. Carr et al.");
  assert.equal(result.pdfUrl, "https://www.govinfo.gov/content/pkg/USREPORTS-369/pdf/USREPORTS-369-186.pdf");
  assert.match(result.payloadHash ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(result.blocking, []);

  const mismatch = parseGovInfoUsReportsDetails(
    govInfoFixture.replaceAll("Baker et al. v. Carr et al.", "Different v. Parties"),
    { caseName: "Baker v. Carr", citation: "369 U.S. 186 (1962)" },
  );
  assert.equal(mismatch.status, "mismatch");
  assert.deepEqual(mismatch.blocking, ["official_case_name_mismatch"]);
});

test("GovInfo resolver respects robots and verifies metadata without auto-promoting constitutional relevance", async () => {
  const candidate = {
    caseName: "Baker v. Carr",
    citation: "369 U.S. 186 (1962)",
    courtClassification: "scotus_candidate" as const,
  };
  let crawled = false;
  const verified = await resolveGovInfoUsReportsAuthority(candidate, {}, {
    now: () => new Date("2026-09-03T09:00:00.000Z"),
    checkRobotsAllowed: async () => ({
      robotsUrl: "https://www.govinfo.gov/robots.txt",
      status: 200,
      allowed: true,
      sitemapUrls: [],
      userAgent: "test",
    }),
    crawlUrl: async (request) => {
      crawled = true;
      return {
        url: request.url,
        finalUrl: request.url,
        status: 200,
        contentType: "text/html",
        html: govInfoFixture,
        text: govInfoFixture,
        headers: {},
        fetchedAt: "2026-09-03T09:00:00.000Z",
        strategy: "fetch",
      };
    },
  });
  assert.equal(crawled, true);
  assert.equal(verified.status, "verified");
  assert.equal(verified.observedAt, "2026-09-03T09:00:00.000Z");

  crawled = false;
  const blocked = await resolveGovInfoUsReportsAuthority(candidate, {}, {
    checkRobotsAllowed: async () => ({
      robotsUrl: "https://www.govinfo.gov/robots.txt",
      status: 200,
      allowed: false,
      matchedRule: "/app/",
      sitemapUrls: [],
      userAgent: "test",
    }),
    crawlUrl: async () => { crawled = true; throw new Error("must not crawl"); },
  });
  assert.equal(crawled, false);
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.blocking, ["robots_disallowed"]);

  const robotsUnavailable = await resolveGovInfoUsReportsAuthority(candidate, {}, {
    checkRobotsAllowed: async () => ({
      robotsUrl: "https://www.govinfo.gov/robots.txt",
      status: 0,
      allowed: true,
      sitemapUrls: [],
      userAgent: "test",
      errorMessage: "timeout",
    }),
    crawlUrl: async () => { throw new Error("must not crawl"); },
  });
  assert.equal(robotsUnavailable.status, "blocked");
  assert.deepEqual(robotsUnavailable.blocking, ["robots_unavailable"]);
});

test("non-SCOTUS reporter candidates never enter the official resolver", async () => {
  await assert.rejects(
    resolveGovInfoUsReportsAuthority({
      caseName: "Example District Case",
      citation: "103 F. Supp. 569 (D.D.C. 1952)",
      courtClassification: "lower_federal",
    }),
    /us_authority\.scotus_candidate_required/,
  );
});

const storedCandidate = {
  id: "77777777-7777-4777-8777-777777777777",
  caseName: "Baker v. Carr",
  citation: "369 U.S. 186 (1962)",
  courtClassification: "scotus_candidate" as const,
};

const verifiedResolution = {
  status: "verified" as const,
  citation: storedCandidate.citation,
  officialCaseName: "Baker et al. v. Carr et al.",
  detailsUrl: "https://www.govinfo.gov/app/details/USREPORTS-369/USREPORTS-369-186",
  pdfUrl: "https://www.govinfo.gov/content/pkg/USREPORTS-369/pdf/USREPORTS-369-186.pdf",
  payloadHash: "f".repeat(64),
  observedAt: "2026-09-03T09:00:00.000Z",
  blocking: [],
};

test("candidate authority service probes without writing an artifact or review", async () => {
  let writes = 0;
  const repository: UsConanAuthorityRepository = {
    getCandidate: async () => storedCandidate,
    recordAuthority: async () => { writes += 1; return "artifact"; },
  };
  const result = await resolveUsConanCandidateAuthority({
    candidateId: storedCandidate.id,
    record: false,
  }, {}, {
    repository,
    resolver: async () => verifiedResolution,
    environment: {},
  });
  assert.equal(result.artifactId, null);
  assert.equal(result.reviewWritten, false);
  assert.equal(result.publicCatalogEnabled, false);
  assert.equal(result.geminiCalls, 0);
  assert.equal(writes, 0);
});

test("recording authority requires the explicit flag and writes only the resolver artifact", async () => {
  let reads = 0;
  let recordedVersion = "";
  const repository: UsConanAuthorityRepository = {
    getCandidate: async () => { reads += 1; return storedCandidate; },
    recordAuthority: async (_candidateId, resolverVersion, resolution) => {
      recordedVersion = resolverVersion;
      assert.deepEqual(resolution, verifiedResolution);
      return "88888888-8888-4888-8888-888888888888";
    },
  };
  await assert.rejects(
    resolveUsConanCandidateAuthority({ candidateId: storedCandidate.id, record: true }, {}, {
      repository,
      resolver: async () => verifiedResolution,
      environment: {},
    }),
    /case_backfill\.us_conan_disabled/,
  );
  assert.equal(reads, 0);
  const result = await resolveUsConanCandidateAuthority({ candidateId: storedCandidate.id, record: true }, {}, {
    repository,
    resolver: async () => verifiedResolution,
    environment: { [US_CONSTITUTION_ANNOTATED_FLAG]: "true" },
  });
  assert.equal(result.artifactId, "88888888-8888-4888-8888-888888888888");
  assert.equal(recordedVersion, GOVINFO_US_REPORTS_RESOLVER_VERSION);
  assert.equal(result.reviewWritten, false);
});

const reviewContext: StoredUsConanReviewContext = {
  id: storedCandidate.id,
  stableCandidateKey: "conan:baker",
  caseName: storedCandidate.caseName,
  citation: storedCandidate.citation,
  normalizedCitation: storedCandidate.citation,
  courtClassification: "scotus_candidate",
  reviewRevision: 1,
  currentStatus: "uncertain",
  essays: [{
    id: "99999999-9999-4999-8999-999999999999",
    essayId: "ALDE_00001001",
    title: "Political Question Doctrine",
    url: "https://constitution.congress.gov/browse/essay/artIII-S2-C1-9-1/ALDE_00001001/",
  }],
  currentAuthority: {
    id: "88888888-8888-4888-8888-888888888888",
    status: "verified",
    detailsUrl: verifiedResolution.detailsUrl,
    pdfUrl: verifiedResolution.pdfUrl,
    observedAt: verifiedResolution.observedAt,
  },
};

function verifiedReviewInput() {
  return {
    candidateId: storedCandidate.id,
    expectedRevision: 1,
    status: "verified",
    officialScotusIdentityVerified: true,
    constitutionalEssayContextVerified: true,
    officialAuthorityVerified: true,
    constitutionalHoldingVerified: true,
    identityRejected: false,
    authorityArtifactId: reviewContext.currentAuthority?.id ?? null,
    officialAuthorityUrl: verifiedResolution.detailsUrl,
    essayEvidenceIds: [reviewContext.essays[0].id],
    holdingEvidence: [{
      sourceUrl: verifiedResolution.pdfUrl,
      locator: "pp. 208-237",
      constitutionalQuestion: "Whether legislative apportionment claims present a justiciable federal constitutional question.",
    }],
    safeEvidence: { essayId: reviewContext.essays[0].essayId },
    reviewedBy: "unit-test-reviewer",
    reviewReason: "All four legal review gates were checked against the bound official evidence.",
  };
}

test("review context inspection is read-only and exposes the exact CAS and evidence identifiers", async () => {
  let writes = 0;
  const repository: UsConanReviewRepository = {
    getReviewContext: async () => reviewContext,
    appendReview: async () => { writes += 1; throw new Error("must not write"); },
  };
  const result = await inspectUsConanCandidateReview(storedCandidate.id, { repository });
  assert.equal(result.expectedRevision, 1);
  assert.equal(result.currentAuthority?.id, reviewContext.currentAuthority?.id);
  assert.deepEqual(result.essayEvidence.map((evidence) => evidence.id), [reviewContext.essays[0].id]);
  assert.equal(result.readOnly, true);
  assert.equal(result.publicCatalogEnabled, false);
  assert.equal(result.geminiCalls, 0);
  assert.equal(writes, 0);
});

test("human review defaults to a read-only evidence-bound plan", async () => {
  let writes = 0;
  const repository: UsConanReviewRepository = {
    getReviewContext: async () => reviewContext,
    appendReview: async () => { writes += 1; throw new Error("must not write"); },
  };
  const result = await reviewUsConanCandidate(verifiedReviewInput(), false, { repository, environment: {} });
  assert.equal(result.mode, "plan");
  assert.equal(result.review, null);
  assert.equal(result.verification.status, "verified");
  assert.equal(result.boundEvidence.essayEvidenceCount, 1);
  assert.equal(result.humanLegalReviewRequired, true);
  assert.equal(result.publicCatalogEnabled, false);
  assert.equal(result.geminiCalls, 0);
  assert.equal(writes, 0);
});

test("human review execution requires its dedicated flag before database access", async () => {
  let reads = 0;
  const repository: UsConanReviewRepository = {
    getReviewContext: async () => { reads += 1; return reviewContext; },
    appendReview: async () => { throw new Error("must not write"); },
  };
  await assert.rejects(
    reviewUsConanCandidate(verifiedReviewInput(), true, { repository, environment: {} }),
    /case_backfill\.us_conan_review_disabled/,
  );
  assert.equal(reads, 0);
});

test("verified review rejects stale authority, foreign essay, and unbound holding evidence", async () => {
  const repository: UsConanReviewRepository = {
    getReviewContext: async () => reviewContext,
    appendReview: async () => { throw new Error("must not write"); },
  };
  await assert.rejects(
    reviewUsConanCandidate({ ...verifiedReviewInput(), authorityArtifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, false, { repository }),
    /us_review\.current_authority_required/,
  );
  await assert.rejects(
    reviewUsConanCandidate({ ...verifiedReviewInput(), essayEvidenceIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"] }, false, { repository }),
    /us_review\.essay_evidence_mismatch/,
  );
  await assert.rejects(
    reviewUsConanCandidate({
      ...verifiedReviewInput(),
      holdingEvidence: [{
        sourceUrl: "https://example.com/not-official",
        locator: "p. 1",
        constitutionalQuestion: "Question",
      }],
    }, false, { repository }),
    /us_review\.holding_authority_mismatch/,
  );
});

test("verified review status cannot disagree with the four legal evidence gates", async () => {
  const repository: UsConanReviewRepository = {
    getReviewContext: async () => reviewContext,
    appendReview: async () => { throw new Error("must not write"); },
  };
  await assert.rejects(
    reviewUsConanCandidate({
      ...verifiedReviewInput(),
      constitutionalHoldingVerified: false,
    }, false, { repository }),
    /us_review\.status_evidence_mismatch/,
  );
});

test("enabled human review appends exactly one v2 review and does not publish", async () => {
  let appended = 0;
  const repository: UsConanReviewRepository = {
    getReviewContext: async () => reviewContext,
    appendReview: async (input) => {
      appended += 1;
      assert.equal(input.authorityArtifactId, reviewContext.currentAuthority?.id);
      assert.deepEqual(input.essayEvidenceIds, [reviewContext.essays[0].id]);
      assert.equal(input.holdingEvidence[0].sourceUrl, verifiedResolution.pdfUrl);
      return {
        reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        revision: 2,
        status: "verified",
      };
    },
  };
  const result = await reviewUsConanCandidate(verifiedReviewInput(), true, {
    repository,
    environment: { [US_CONAN_REVIEW_FLAG]: "true" },
  });
  assert.equal(appended, 1);
  assert.equal(result.mode, "reviewed");
  assert.equal(result.review?.revision, 2);
  assert.equal(result.publicCatalogEnabled, false);
  assert.equal(result.geminiCalls, 0);
});

const catalogContext: UsConanCatalogPublicationContext = {
  candidateId: storedCandidate.id,
  citation: storedCandidate.citation,
  reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  reviewRevision: 2,
  reviewStatus: "verified",
  reviewAuthorityArtifactId: reviewContext.currentAuthority?.id ?? null,
  currentAuthorityArtifactId: reviewContext.currentAuthority?.id ?? null,
  currentAuthorityStatus: "verified",
  candidateSourceKey: "us-constitution-annotated",
  candidatePolicyVersion: "us-conan-gate5-v1",
  candidatePolicyReviewDueAt: "2027-09-03T00:00:00.000Z",
  candidateSnapshotStatus: "closed",
  candidateManifestHash: "c".repeat(64),
  articleId: null,
  catalogRevision: 0,
  catalogState: null,
};

const catalogPolicy: UsConanCatalogSourcePolicy = {
  sourceKey: "us-scotus",
  policyVersion: "us-scotus-gate5-v1",
  reviewDueAt: "2027-09-03T00:00:00.000Z",
  textAccessPolicy: "metadata_only",
  authorityHosts: ["www.govinfo.gov"],
};

function usCatalogRepository(overrides: Partial<UsConanCatalogRepository> = {}): UsConanCatalogRepository {
  return {
    getPublicationContext: async () => catalogContext,
    getSourcePolicy: async () => catalogPolicy,
    publish: async () => ({
      eventId: "11111111-1111-4111-8111-111111111111",
      articleId: "22222222-2222-4222-8222-222222222222",
      versionId: "33333333-3333-4333-8333-333333333333",
      versionRevision: 1,
      publicationRevision: 1,
      articleSlug: "us-scotus-369-us-186",
      applied: true,
      idempotent: false,
    }),
    ...overrides,
  };
}

test("US Catalog publication plan is read-only and exposes exact review and Catalog CAS values", async () => {
  let writes = 0;
  const repository = usCatalogRepository({
    publish: async () => {
      writes += 1;
      throw new Error("must not write");
    },
  });
  const result = await planUsConanCatalogPublication(storedCandidate.id, catalogPolicy.policyVersion, {
    repository,
    environment: {},
    now: () => new Date("2026-09-03T10:00:00.000Z"),
  });
  assert.equal(result.mode, "plan");
  assert.equal(result.eligible, true);
  assert.deepEqual(result.blocking, []);
  assert.equal(result.expectedReviewRevision, 2);
  assert.equal(result.expectedCatalogRevision, 0);
  assert.equal(
    result.idempotencyKey,
    `us-conan:${storedCandidate.id}:review-2:policy-${catalogPolicy.policyVersion}`,
  );
  assert.equal(result.writeEnabled, false);
  assert.equal(result.publicCatalogEnabled, false);
  assert.equal(result.geminiCalls, 0);
  assert.equal(writes, 0);
});

test("US Catalog publication requires both write flags before database access", async () => {
  let reads = 0;
  const repository = usCatalogRepository({
    getPublicationContext: async () => {
      reads += 1;
      return catalogContext;
    },
    getSourcePolicy: async () => {
      reads += 1;
      return catalogPolicy;
    },
  });
  const input = {
    candidateId: storedCandidate.id,
    sourcePolicyVersion: catalogPolicy.policyVersion,
    expectedReviewRevision: 2,
    expectedCatalogRevision: 0,
    idempotencyKey: `us-conan:${storedCandidate.id}:review-2:policy-${catalogPolicy.policyVersion}`,
    actorId: "unit-test-publisher",
  };
  await assert.rejects(
    publishUsConanCatalogCandidate(input, { repository, environment: {} }),
    /case_backfill\.catalog_write_disabled/,
  );
  await assert.rejects(
    publishUsConanCatalogCandidate(input, {
      repository,
      environment: { CASE_CATALOG_WRITE_ENABLED: "true" },
    }),
    /case_backfill\.us_conan_publish_disabled/,
  );
  assert.equal(reads, 0);
});

test("US Catalog publication plan blocks stale evidence, source mismatch, and overdue policy", async () => {
  const repository = usCatalogRepository({
    getPublicationContext: async () => ({
      ...catalogContext,
      candidateSourceKey: "unexpected-source",
      reviewAuthorityArtifactId: "44444444-4444-4444-8444-444444444444",
      candidatePolicyReviewDueAt: "2026-09-03T09:59:59.000Z",
    }),
    getSourcePolicy: async () => ({
      ...catalogPolicy,
      reviewDueAt: "2026-09-03T09:59:59.000Z",
      authorityHosts: [],
      textAccessPolicy: "full_text_allowed",
    }),
  });
  const result = await planUsConanCatalogPublication(storedCandidate.id, catalogPolicy.policyVersion, {
    repository,
    now: () => new Date("2026-09-03T10:00:00.000Z"),
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.blocking, [
    "candidate_discovery_source_mismatch",
    "current_reviewed_authority_required",
    "candidate_policy_review_overdue",
    "publication_policy_review_overdue",
    "govinfo_authority_host_required",
    "metadata_only_policy_required",
  ]);
});

test("US Catalog publication rejects stale CAS and a substituted idempotency key", async () => {
  let writes = 0;
  const repository = usCatalogRepository({
    publish: async () => {
      writes += 1;
      throw new Error("must not write");
    },
  });
  const environment = {
    CASE_CATALOG_WRITE_ENABLED: "true",
    [US_CONAN_CATALOG_PUBLISH_FLAG]: "true",
  };
  const baseInput = {
    candidateId: storedCandidate.id,
    sourcePolicyVersion: catalogPolicy.policyVersion,
    expectedReviewRevision: 2,
    expectedCatalogRevision: 0,
    idempotencyKey: `us-conan:${storedCandidate.id}:review-2:policy-${catalogPolicy.policyVersion}`,
    actorId: "unit-test-publisher",
  };
  await assert.rejects(
    publishUsConanCatalogCandidate({ ...baseInput, expectedReviewRevision: 1 }, {
      repository,
      environment,
      now: () => new Date("2026-09-03T10:00:00.000Z"),
    }),
    /us_catalog\.stale_plan/,
  );
  await assert.rejects(
    publishUsConanCatalogCandidate({ ...baseInput, idempotencyKey: "substituted-key" }, {
      repository,
      environment,
      now: () => new Date("2026-09-03T10:00:00.000Z"),
    }),
    /us_catalog\.idempotency_key_mismatch/,
  );
  assert.equal(writes, 0);
});

test("enabled US Catalog publication performs one metadata-only bridge write", async () => {
  let writes = 0;
  const repository = usCatalogRepository({
    publish: async (input) => {
      writes += 1;
      assert.equal(input.expectedReviewRevision, 2);
      assert.equal(input.expectedCatalogRevision, 0);
      assert.equal(input.sourcePolicyVersion, catalogPolicy.policyVersion);
      return {
        eventId: "11111111-1111-4111-8111-111111111111",
        articleId: "22222222-2222-4222-8222-222222222222",
        versionId: "33333333-3333-4333-8333-333333333333",
        versionRevision: 1,
        publicationRevision: 1,
        articleSlug: "us-scotus-369-us-186",
        applied: true,
        idempotent: false,
      };
    },
  });
  const idempotencyKey = `us-conan:${storedCandidate.id}:review-2:policy-${catalogPolicy.policyVersion}`;
  const result = await publishUsConanCatalogCandidate({
    candidateId: storedCandidate.id,
    sourcePolicyVersion: catalogPolicy.policyVersion,
    expectedReviewRevision: 2,
    expectedCatalogRevision: 0,
    idempotencyKey,
    actorId: "unit-test-publisher",
  }, {
    repository,
    environment: {
      CASE_CATALOG_WRITE_ENABLED: "true",
      [US_CONAN_CATALOG_PUBLISH_FLAG]: "true",
    },
    now: () => new Date("2026-09-03T10:00:00.000Z"),
  });
  assert.equal(writes, 1);
  assert.equal(result.mode, "published");
  assert.equal(result.publication.articleSlug, "us-scotus-369-us-186");
  assert.equal(result.reviewWritten, false);
  assert.equal(result.p3PublicationWritten, false);
  assert.equal(result.geminiCalls, 0);
});
