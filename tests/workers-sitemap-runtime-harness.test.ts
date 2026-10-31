import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runWorkersSitemapAcceptanceGate } from "../scripts/workers-sitemap-runtime-harness";

const REPO_ROOT = process.cwd();

test("workers sitemap harness is local-only and cannot address production D1", async () => {
  const harness = await readFile(join(REPO_ROOT, "scripts", "workers-sitemap-runtime-harness.ts"), "utf8");
  const worker = await readFile(join(REPO_ROOT, "scripts", "fixtures", "worldcons-sitemap-runtime-worker.ts"), "utf8");
  const combined = `${harness}\n${worker}`;

  assert.match(harness, /d1Databases: \{ \[LOCAL_D1_BINDING\]: LOCAL_D1_DATABASE_ID \}/);
  assert.match(harness, /outboundService: async \(\) => \{\s*throw new Error\("harness_network_disabled"\);/);
  assert.match(harness, /mkdtemp\(join\(tmpdir\(\), "worldcons-sitemap-worker-"\)\)/);
  assert.match(harness, /await rm\(tempDir, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(combined, /wrangler\s+dev|--remote|CLOUDFLARE_API|CLOUDFLARE_ACCOUNT/i);
  assert.doesNotMatch(combined, /0f4c41f0-778f-4ef4-860e-b0dad05f0984/i);
  assert.doesNotMatch(combined, /0ccd27ff-fd16-4071-bc94-616690708c4e/i);
  assert.doesNotMatch(combined, /6ecdf64b-d95a-49b2-8fc4-bdd50581a3e4/i);
  assert.doesNotMatch(combined, /1d74ebba-918b-4f8c-9c5c-9013479df809/i);
});

test(
  "workers sitemap harness runs the four-switch matrix in isolated workerd with one local D1",
  { timeout: 90_000 },
  async () => {
    const report = await runWorkersSitemapAcceptanceGate({ basePublished: 20, timeoutMs: 80_000 });

    assert.equal(report.dataset.basePublished, 20);
    assert.equal(report.dataset.visibleArticles, 22);
    assert.equal(report.runs.length, 4);
    assert.equal(report.negative.length, 4);
    assert.equal(report.parity.allNormalizedSetsEqual, true);
    assert.equal(report.parity.allXmlBytesEqual, true);
    assert.match(report.parity.baselineNormalizedSha256, /^[0-9a-f]{64}$/);

    for (const run of report.runs) {
      assert.equal(run.status, 200);
      assert.equal(run.entries, 22);
      assert.equal(run.normalizedSha256, report.parity.baselineNormalizedSha256);
      assert.ok(run.statements > 0);
      assert.equal(run.rowsReadAvailable, true);
      assert.ok((run.rowsRead ?? 0) > 0);
      assert.ok(report.safety.matrixFetches <= 4);
    }

    for (const negative of report.negative) {
      assert.equal(negative.status, 200);
      assert.equal(negative.pendingWithheld, true);
      assert.equal(negative.sameXmlAsBaseline, true);
    }

    assert.equal(report.safety.localD1Binding, "WORLDCONS_CORE");
    assert.equal(report.safety.localDatabaseId, "worldcons-local-sitemap-harness");
    assert.equal(report.safety.outboundNetworkDisabled, true);
    assert.equal(report.safety.tempDirRemoved, true);
    assert.equal(report.safety.negativeFetches, 4);
    assert.ok(report.safety.totalElapsedMs <= 80_000);
  },
);
