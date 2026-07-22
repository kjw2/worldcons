import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ingestResultFailureMessage, ingestResultSucceeded } from "../lib/ingest/results";
import { ingestionRunIdFromSourceMetadata } from "../lib/ingest/summary";

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

test("daily workflow and all ingestion CLIs retain hardening controls", () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const workflow = read(".github/workflows/crawlee-worker.yml");
  const scheduledCli = read("scripts/crawlee-worker.ts");
  const secondaryCli = read("workers/crawler/src/cli.ts");
  const directCli = read("scripts/ingest.ts");
  const spainSpider = read("lib/crawlee/spain-tribunal-constitucional-spider.ts");
  const summary = read("lib/ingest/summary.ts");

  assert.match(workflow, /LLM_SETTINGS_SECRET: \$\{\{ secrets\.LLM_SETTINGS_SECRET \}\}/);
  assert.match(workflow, /SPAIN_REQUEST_DELAY_MS: "2000"/);
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
  assert.match(summary, /syncIngestionRunSummarizedCounts/);
  assert.match(summary, /Failed to persist article summary/);
});

