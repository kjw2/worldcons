import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ingestResultFailureMessage, ingestResultSucceeded } from "../lib/ingest/results";
import { ingestionRunIdFromSourceMetadata } from "../lib/ingest/summary";
import {
  bverfgOfficialUrlCandidatesFromDocket,
  bverfgOfficialUrlCandidatesFromUrl,
} from "../lib/crawlee/bverfg-spider";
import {
  bverfgCandidateRetryDelayMs,
  refreshQualityRegressionReason,
  shouldRetryBverfgCandidates,
} from "../lib/ingest/run";
import type { SourceUrlCandidateRecord } from "../lib/db/source-url-candidates";

test("ingestion success distinguishes a verified empty listing from swallowed discovery failures", () => {
  const verifiedEmpty = {
    mode: "database",
    results: [{
      sourceKey: "us-scotus",
      discoveredCount: 0,
      failedCount: 0,
      errors: [],
      diagnostics: { attempts: [{ strategy: "official-listing", status: 200, discoveredCount: 0 }] },
    }],
  };
  const swallowedFailure = {
    mode: "database",
    results: [{
      sourceKey: "us-scotus",
      discoveredCount: 0,
      failedCount: 0,
      errors: [],
      diagnostics: { attempts: [{ strategy: "official-listing", result: "failed", errorCode: "ETIMEDOUT" }] },
    }],
  };

  assert.equal(ingestResultSucceeded(verifiedEmpty), true);
  assert.equal(ingestResultSucceeded(swallowedFailure), false);
  assert.match(ingestResultFailureMessage(swallowedFailure), /us-scotus: ETIMEDOUT/);
});

test("ingestion success rejects blocked, no-database, empty, and partial failure results", () => {
  assert.equal(ingestResultSucceeded({ mode: "blocked", results: [] }), false);
  assert.equal(ingestResultSucceeded({ mode: "no-database", results: [{}] }), false);
  assert.equal(ingestResultSucceeded({ mode: "database", results: [] }), false);
  assert.equal(
    ingestResultSucceeded({ mode: "database", results: [{ discoveredCount: 1, failedCount: 1, errors: ["failed"] }] }),
    false,
  );
  assert.equal(
    ingestResultSucceeded({ mode: "database", results: [{ discoveredCount: 20, failedCount: 0, errors: [] }] }),
    true,
  );
});

test("summary accounting only accepts an ingestion run UUID from collection metadata", () => {
  const runId = "c5347191-0607-4d11-bff7-2f7ac6617c79";
  assert.equal(ingestionRunIdFromSourceMetadata({ collection: { diagnosticsId: runId } }), runId);
  assert.equal(ingestionRunIdFromSourceMetadata({ collection: { diagnosticsId: "not-a-uuid" } }), undefined);
  assert.equal(ingestionRunIdFromSourceMetadata({}), undefined);
});

test("BVerfG URL resolution checks chamber and senate filename variants", () => {
  assert.deepEqual(
    bverfgOfficialUrlCandidatesFromDocket("22.07.2026", "2 BvR 319/26").map((url) => url.split("/").at(-1)),
    ["rk20260722_2bvr031926.html", "rs20260722_2bvr031926.html"],
  );
  assert.deepEqual(
    bverfgOfficialUrlCandidatesFromDocket("09.07.2026", "2 BvQ 47/26").map((url) => url.split("/").at(-1)),
    ["qk20260709_2bvq004726.html", "qs20260709_2bvq004726.html"],
  );
  assert.deepEqual(
    bverfgOfficialUrlCandidatesFromDocket("09.07.2026", "2 BvE 4/26").map((url) => url.split("/").at(-1)),
    ["es20260709_2bve000426.html"],
  );
  assert.deepEqual(
    bverfgOfficialUrlCandidatesFromUrl(
      "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/07/rk20260722_2bvr031926.html",
    ).map((url) => url.split("/").at(-1)),
    ["rk20260722_2bvr031926.html", "rs20260722_2bvr031926.html"],
  );
});

test("BVerfG unresolved variant retries use short bounded backoff with schedule grace", () => {
  assert.equal(bverfgCandidateRetryDelayMs(16, "BVERFG_OFFICIAL_DETAIL_404"), 0);
  assert.equal(bverfgCandidateRetryDelayMs(1, "BVERFG_OFFICIAL_VARIANTS_404"), 12 * 60 * 60 * 1000);
  assert.equal(bverfgCandidateRetryDelayMs(3, "BVERFG_OFFICIAL_VARIANTS_404"), 24 * 60 * 60 * 1000);
  assert.equal(bverfgCandidateRetryDelayMs(6, "BVERFG_OFFICIAL_VARIANTS_404"), 2 * 24 * 60 * 60 * 1000);
  assert.equal(bverfgCandidateRetryDelayMs(10, "BVERFG_OFFICIAL_VARIANTS_404"), 3 * 24 * 60 * 60 * 1000);

  const candidate: SourceUrlCandidateRecord = {
    id: "candidate-1",
    sourceKey: "de-bverfg",
    url: "https://www.bundesverfassungsgericht.de/example.html",
    candidateType: "decision",
    discoveredBy: "dejure",
    status: "retrying",
    lastAttemptAt: "2026-07-20T00:00:00.000Z",
    attemptCount: 10,
    lastErrorCode: "BVERFG_OFFICIAL_VARIANTS_404",
  };
  assert.equal(shouldRetryBverfgCandidates([candidate], new Date("2026-07-22T12:00:00.000Z")), false);
  assert.equal(shouldRetryBverfgCandidates([candidate], new Date("2026-07-22T18:00:00.000Z")), true);
});

test("public article refreshes reject incomplete or suspiciously shrunken source text", () => {
  const baseline = {
    existingWasPublic: true,
    existingTextLength: 10_000,
    incomingPublishable: true,
    incomingSourceTextAvailable: true,
  };

  assert.equal(
    refreshQualityRegressionReason({
      ...baseline,
      incomingTextLength: 52,
      incomingPublishable: false,
      incomingSourceTextAvailable: false,
    }),
    "incoming_source_text_unavailable",
  );
  assert.equal(
    refreshQualityRegressionReason({ ...baseline, incomingTextLength: 5_999 }),
    "incoming_source_text_shrank_suspiciously",
  );
  assert.equal(refreshQualityRegressionReason({ ...baseline, incomingTextLength: 6_000 }), null);
  assert.equal(
    refreshQualityRegressionReason({
      ...baseline,
      existingWasPublic: false,
      incomingTextLength: 52,
      incomingPublishable: false,
      incomingSourceTextAvailable: false,
    }),
    null,
  );
});

test("daily workflow and all ingestion CLIs retain hardening controls", () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const workflow = read(".github/workflows/crawlee-worker.yml");
  const scheduledCli = read("scripts/crawlee-worker.ts");
  const secondaryCli = read("workers/crawler/src/cli.ts");
  const directCli = read("scripts/ingest.ts");
  const spainSpider = read("lib/crawlee/spain-tribunal-constitucional-spider.ts");
  const ingest = read("lib/ingest/run.ts");
  const summary = read("lib/ingest/summary.ts");

  assert.match(workflow, /LLM_SETTINGS_SECRET: \$\{\{ secrets\.LLM_SETTINGS_SECRET \}\}/);
  assert.match(workflow, /SPAIN_REQUEST_DELAY_MS: "2000"/);
  assert.match(workflow, /ARTICLE_LIFECYCLE_P2_SHADOW_WRITE_ENABLED:/);
  assert.match(workflow, /ARTICLE_LIFECYCLE_P2_SHADOW_COHORTS:/);
  assert.match(workflow, /ADMIN_PUBLICATION_V4_SHADOW_WRITE_ENABLED:/);
  assert.match(workflow, /ADMIN_PUBLICATION_V4_OUTBOX_PROCESSOR_ENABLED:/);
  assert.match(workflow, /admin:publication:p3 -- --outbox --drain/);
  assert.match(workflow, /admin:lifecycle:p2 --require-parity/);
  assert.match(workflow, /admin:publication:p3 -- --require-parity/);
  for (const cli of [scheduledCli, secondaryCli, directCli]) {
    assert.match(cli, /ingestResultSucceeded/);
    assert.match(cli, /ingestResultFailureMessage/);
  }
  for (const cli of [scheduledCli, secondaryCli, directCli]) {
    assert.match(cli, /range-days/);
    assert.match(cli, /refresh-existing/);
  }
  assert.match(spainSpider, /checkRobotsAllowed/);
  assert.match(spainSpider, /respectRateLimit/);
  assert.match(ingest, /BVERFG_TRACKED_CANDIDATE_RECHECK/);
  assert.match(ingest, /REFRESH_QUALITY_REGRESSION_BLOCKED/);
  assert.match(summary, /syncIngestionRunSummarizedCounts/);
  assert.match(summary, /Failed to persist article summary/);
});
