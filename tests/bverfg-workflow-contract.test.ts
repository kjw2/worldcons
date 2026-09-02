import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function workflow(name: string) {
  return fs.readFileSync(path.join(process.cwd(), ".github/workflows", name), "utf8");
}

test("BVerfG collection and diagnostics share the production-safe timeout", () => {
  for (const name of ["crawlee-worker.yml", "bverfg-diagnose.yml", "admin-job-worker.yml", "admin-watchdog.yml"]) {
    assert.match(workflow(name), /BVERFG_TIMEOUT_MS: "60000"/u, name);
  }
  assert.doesNotMatch(workflow("crawlee-worker.yml"), /BVERFG_TIMEOUT_MS: "15000"/u);
  assert.match(workflow("crawlee-worker.yml"), /BVERFG_RETRY_COUNT: "0"/u);
});

test("BVerfG diagnostics follows the sitemap advertised by robots.txt", () => {
  const diagnostics = fs.readFileSync(path.join(process.cwd(), "lib/crawler/network-diagnostics.ts"), "utf8");
  assert.match(diagnostics, /robotsParsed\?\.sitemapUrls\[0\] \?\? defaultSitemapUrl/u);
  assert.doesNotMatch(diagnostics, /const sitemapUrl = `\$\{baseUrl\}\/sitemap\.xml`/u);
});
