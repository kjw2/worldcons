import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  incrementalRangeDaysFromCheckpoint,
  ingestSourceOutcomeLine,
} from "../lib/ingest/incremental";
import {
  ingestProcessExitCode,
  ingestResultFailureMessage,
  ingestResultOutcome,
  ingestResultSucceeded,
} from "../lib/ingest/results";
import { ingestionRunIdFromSourceMetadata } from "../lib/ingest/summary";
import {
  bverfgOfficialUrlCandidatesFromDocket,
  bverfgOfficialUrlCandidatesFromUrl,
} from "../lib/crawlee/bverfg-spider";
import {
  bverfgCandidateRetryDelayMs,
  isDiscoveredItemInCollectionRange,
  refreshQualityRegressionReason,
  shouldRetryBverfgCandidates,
} from "../lib/ingest/run";
import { crawlerErrorStatus } from "../lib/crawlee/shared";
import { DEFAULT_CRAWLER_USER_AGENT, crawlerHeaders } from "../lib/crawler/user-agents";
import { buildSpainTcRawArticleFromJson, isSpainMetadataOnlyNotice } from "../lib/crawlee/spain-tribunal-constitucional-spider";
import { caseNumberFromArticle, withCaseNumberMetadata } from "../lib/ingest/case-number";
import { scotusRevisionDateFromRowText } from "../lib/sources/supremecourt";
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

test("ingestion treats all-uncollected BVerfG runs as degraded, not success", () => {
  const blocked = {
    mode: "database",
    results: [{
      sourceKey: "de-bverfg",
      discoveredCount: 21,
      attemptedCount: 21,
      verifiedSourceTextCount: 0,
      fetchedCount: 21,
      failedCount: 0,
      errors: [],
      uncollectedCount: 21,
      uncollectedCandidates: Array.from({ length: 21 }, () => ({ errorCode: "BVERFG_OFFICIAL_DETAIL_UNVERIFIED" })),
    }],
  };
  assert.equal(ingestResultOutcome(blocked), "degraded");
  assert.equal(ingestResultSucceeded(blocked), false);
  assert.equal(ingestProcessExitCode(blocked), 2);
  assert.match(ingestResultFailureMessage(blocked), /degraded collection/);
});

test("Crawlee failures preserve HTTP status for BVerfG block classification", () => {
  assert.equal(crawlerErrorStatus(new Error("Request blocked - received 403 status code.")), 403);
  assert.equal(crawlerErrorStatus({ response: { statusCode: 429 } }), 429);
  assert.equal(crawlerErrorStatus(new Error("network reset")), undefined);
});

test("crawler defaults identify the bot and send browser-compatible request headers", () => {
  assert.match(DEFAULT_CRAWLER_USER_AGENT, /ConstitutionalCourtCurationBot/);
  assert.match(DEFAULT_CRAWLER_USER_AGENT, /worldcons\.vercel\.app/);
  const headers = crawlerHeaders();
  assert.equal(headers["User-Agent"], DEFAULT_CRAWLER_USER_AGENT);
  assert.match(headers.Accept, /text\/html/);
  assert.match(headers["Accept-Language"], /de/);
});

test("Spain explicitly metadata-only notices are not retried as missing full text", () => {
  assert.equal(isSpainMetadataOnlyNotice("Este auto no incorpora doctrina constitucional."), true);
  assert.equal(isSpainMetadataOnlyNotice("Resolución con doctrina constitucional."), false);
  const raw = buildSpainTcRawArticleFromJson({
    ID: 32117,
    TIPO_RESOLUCION: "AUTO",
    NUMERO_RESOLUCION: 52,
    ANNO_RESOLUCION: 2026,
    FECHA_REGISTRO: "08/07/2026 0:00:00",
    AVISO: "Este auto no incorpora doctrina constitucional.",
  });
  assert.equal(raw.metadata?.sourceTextStatus, "not_available");
  assert.match(String(raw.metadata?.collection?.reason), /intentionally unavailable/);
});

test("canonical caseNumber metadata is populated from source-specific aliases", () => {
  assert.equal(caseNumberFromArticle({ sourceKey: "us-scotus", metadata: { docket: "24-109" } }), "24-109");
  assert.equal(caseNumberFromArticle({ sourceKey: "fr-conseil-constitutionnel", metadata: { decisionNumber: "Décision n° 2026-912 DC" } }), "2026-912 DC");
  assert.equal(caseNumberFromArticle({ sourceKey: "es-tribunal-constitucional", metadata: { resolutionNumber: "53/2025" } }), "53/2025");
  assert.equal(
    caseNumberFromArticle({
      sourceKey: "de-bverfg",
      url: "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/08/rk20260811_2bvr150226.html",
    }),
    "2 BvR 1502/26",
  );
  assert.deepEqual(
    withCaseNumberMetadata({ sourceKey: "us-scotus", metadata: { docket: "24-109" } }),
    { docket: "24-109", caseNumber: "24-109" },
  );
});

test("expected empty sitemap and Spain tail probes do not fail a verified listing", () => {
  const france = {
    mode: "database",
    results: [{
      sourceKey: "fr-conseil-constitutionnel",
      discoveredCount: 10,
      attemptedCount: 10,
      verifiedSourceTextCount: 10,
      failedCount: 0,
      errors: [],
      diagnostics: {
        attempts: [
          { strategy: "cheerio", status: 200, discoveredCount: 10 },
          {
            strategy: "sitemap",
            status: 404,
            optional: true,
            result: "empty",
            url: "https://www.conseil-constitutionnel.fr/sitemap_index.xml",
          },
        ],
      },
    }],
  };
  const spainEmptyDiscovery = {
    mode: "database",
    results: [{
      sourceKey: "es-tribunal-constitucional",
      discoveredCount: 0,
      failedCount: 0,
      errors: [],
      diagnostics: {
        attempts: [
          { strategy: "api", status: 200, discoveredCount: 0 },
          { strategy: "api", optional: true, result: "empty", errorCode: "SPAIN_HJ_TAIL_PROBE_EMPTY" },
        ],
      },
    }],
  };
  assert.equal(ingestResultSucceeded(france), true);
  assert.equal(ingestResultSucceeded(spainEmptyDiscovery), true);
});

test("incremental range widens from the last verified checkpoint and never shrinks below the floor", () => {
  assert.equal(
    incrementalRangeDaysFromCheckpoint({
      sourceKey: "de-bverfg",
      floorDays: 60,
      lastVerifiedPublishedAt: "2026-08-15T00:00:00.000Z",
      now: Date.parse("2026-08-16T00:00:00.000Z"),
    }),
    60,
  );
  assert.equal(
    incrementalRangeDaysFromCheckpoint({
      sourceKey: "us-scotus",
      floorDays: 14,
      lastSuccessfulRunAt: "2026-07-01T00:00:00.000Z",
      now: Date.parse("2026-08-16T00:00:00.000Z"),
    }),
    30,
  );
});

test("worker outcome lines stay compact and omit source URLs", () => {
  const line = ingestSourceOutcomeLine({
    sourceKey: "de-bverfg",
    outcome: "degraded",
    discoveredCount: 21,
    attemptedCount: 21,
    verifiedSourceTextCount: 0,
    uncollectedCount: 21,
    blocked403Count: 21,
    circuitBroken: true,
  });
  assert.equal(line.source, "de-bverfg");
  assert.equal(line.outcome, "degraded");
  assert.equal(line.verified, 0);
  assert.equal(line.uncollected, 21);
  assert.equal(JSON.stringify(line).includes("http"), false);
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
  assert.equal(bverfgCandidateRetryDelayMs(1, "BVERFG_OFFICIAL_DETAIL_403"), 6 * 60 * 60 * 1000);
  assert.equal(bverfgCandidateRetryDelayMs(3, "BVERFG_OFFICIAL_DETAIL_UNVERIFIED"), 24 * 60 * 60 * 1000);
  assert.equal(bverfgCandidateRetryDelayMs(6, "BVERFG_SITE_BLOCK_CIRCUIT_OPEN"), 3 * 24 * 60 * 60 * 1000);
  assert.equal(bverfgCandidateRetryDelayMs(1, "CRAWLEE_DETAIL_EMPTY"), 3 * 60 * 60 * 1000);

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

  const blocked: SourceUrlCandidateRecord = {
    ...candidate,
    lastAttemptAt: "2026-08-15T21:15:00.000Z",
    attemptCount: 1,
    lastErrorCode: "BVERFG_OFFICIAL_DETAIL_UNVERIFIED",
  };
  assert.equal(shouldRetryBverfgCandidates([blocked], new Date("2026-08-16T00:00:00.000Z")), false);
  assert.equal(shouldRetryBverfgCandidates([blocked], new Date("2026-08-16T03:16:00.000Z")), true);
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

test("SCOTUS revision dates are independently eligible from the opinion date window", () => {
  assert.equal(scotusRevisionDateFromRowText("Opinion PDF Revisions: 7/07/26"), "2026-07-07T00:00:00.000Z");

  const revisedOpinion = {
    sourceKey: "us-scotus" as const,
    publishedAt: "2026-06-30",
    metadata: { revisionDate: "2026-07-07T00:00:00.000Z" },
  };
  assert.equal(
    isDiscoveredItemInCollectionRange(
      revisedOpinion,
      new Date("2026-07-25T00:00:00.000Z"),
      new Date("2026-05-10T00:00:00.000Z"),
    ),
    true,
  );
  assert.equal(
    isDiscoveredItemInCollectionRange(
      { ...revisedOpinion, metadata: { revisionDate: "2026-04-01T00:00:00.000Z" } },
      new Date("2026-07-25T00:00:00.000Z"),
      new Date("2026-05-10T00:00:00.000Z"),
    ),
    false,
  );
  assert.equal(
    isDiscoveredItemInCollectionRange(revisedOpinion, undefined, new Date("2026-05-10T00:00:00.000Z")),
    true,
  );
  assert.equal(
    isDiscoveredItemInCollectionRange(
      { ...revisedOpinion, metadata: { revisionDate: "2026-04-01T00:00:00.000Z" } },
      undefined,
      new Date("2026-05-10T00:00:00.000Z"),
    ),
    false,
  );
});

test("daily workflow and all ingestion CLIs retain hardening controls", () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const workflow = read(".github/workflows/crawlee-worker.yml");
  const scheduledCli = read("scripts/crawlee-worker.ts");
  const secondaryCli = read("workers/crawler/src/cli.ts");
  const directCli = read("scripts/ingest.ts");
  const spainSpider = read("lib/crawlee/spain-tribunal-constitucional-spider.ts");
  const sitemap = read("lib/crawler/sitemap.ts");
  const ingest = read("lib/ingest/run.ts");
  const summary = read("lib/ingest/summary.ts");

  assert.match(workflow, /LLM_SETTINGS_SECRET: \$\{\{ secrets\.LLM_SETTINGS_SECRET \}\}/);
  assert.match(workflow, /matrix:\s+source:/, "daily workflow must isolate each source in its own job");
  assert.match(workflow, /max-parallel: 4/, "daily workflow must allow independent sources to continue after one source stalls");
  assert.match(workflow, /BVERFG_PENDING_RECHECK_LIMIT: "3"/, "BVerfG retry work must be bounded per run");
  assert.match(workflow, /SCOTUS_REVISION_RECHECK_DAYS: "90"/, "SCOTUS revisions must have an independent recheck window");
  assert.match(workflow, /SCOTUS_REVISION_RECHECK_LIMIT: "100"/, "SCOTUS revision rechecks must be bounded per run");
  assert.match(workflow, /BVERFG_RETRY_COUNT: "0"/, "BVerfG daily retries must not multiply a slow official endpoint");
  assert.match(workflow, /BVERFG_SITE_BLOCK_CIRCUIT_THRESHOLD: "3"/);
  assert.match(workflow, /BVERFG_PLAYWRIGHT_ESCALATE_LIMIT: "3"/);
  assert.match(workflow, /CRAWLER_USER_AGENT: .*ConstitutionalCourtCurationBot/);
  assert.match(workflow, /Run isolated BVerfG worker without browser fallback[\s\S]*--no-playwright/, "BVerfG daily detail checks must use bounded HTTP fallback only");
  assert.match(workflow, /postprocess:[\s\S]*if: always\(\)/, "postprocess must run after partial source failures");
  assert.match(workflow, /continue-on-error: \$\{\{ vars\.ADMIN_REQUIRE_PUBLICATION_PARITY != 'true' \}\}/, "legacy parity drift must not falsely fail collection by default");
  assert.match(workflow, /SPAIN_REQUEST_DELAY_MS: "2000"/);
  assert.match(workflow, /ARTICLE_LIFECYCLE_P2_SHADOW_WRITE_ENABLED:/);
  assert.match(workflow, /ARTICLE_LIFECYCLE_P2_SHADOW_COHORTS:/);
  assert.match(workflow, /ADMIN_PUBLICATION_V4_SHADOW_WRITE_ENABLED:/);
  assert.match(workflow, /ADMIN_PUBLICATION_V4_OUTBOX_PROCESSOR_ENABLED:/);
  assert.match(workflow, /admin:publication:p3 -- --outbox --drain/);
  assert.match(workflow, /admin:lifecycle:p2 --require-parity/);
  assert.match(workflow, /admin:publication:p3 -- --require-parity/);
  for (const cli of [scheduledCli, secondaryCli, directCli]) {
    assert.match(cli, /ingestProcessExitCode/);
    assert.match(cli, /ingestResultFailureMessage/);
    assert.match(cli, /ingestSourceOutcomeLine/);
  }
  for (const cli of [scheduledCli, secondaryCli, directCli]) {
    assert.match(cli, /range-days/);
    assert.match(cli, /refresh-existing/);
  }
  assert.match(spainSpider, /checkRobotsAllowed/);
  assert.match(spainSpider, /respectRateLimit/);
  assert.match(spainSpider, /result: "empty"/);
  assert.match(spainSpider, /SPAIN_HJ_TAIL_PROBE_EMPTY/);
  assert.match(sitemap, /sitemap_index\\.xml/);
  assert.match(sitemap, /optionalIndex/);
  assert.match(ingest, /BVERFG_TRACKED_CANDIDATE_RECHECK/);
  assert.match(ingest, /recoverStaleIngestionRuns/);
  assert.match(ingest, /INGESTION_RUN_STALE_MINUTES/);
  assert.match(ingest, /REFRESH_QUALITY_REGRESSION_BLOCKED/);
  assert.match(summary, /syncIngestionRunSummarizedCounts/);
  assert.match(summary, /Failed to persist article summary/);
});
