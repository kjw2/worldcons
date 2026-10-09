import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveM8CrawlerSourcePolicy } from "@/lib/cloudflare/async-pipeline/crawler-source-ownership";
import { NATIVE_CRAWLER_SOURCES } from "../workers/async-pipeline/src/native-crawler";

const root = process.cwd();
const NATIVE = [...NATIVE_CRAWLER_SOURCES];

test("absent/empty exclusion keeps every native source legacy-owned", () => {
  for (const raw of [undefined, null, "", "   "]) {
    const policy = resolveM8CrawlerSourcePolicy(raw, NATIVE);
    assert.equal(policy.valid, true);
    assert.deepEqual(policy.excluded, []);
    assert.deepEqual(policy.effective, NATIVE);
  }
});

test("France exclusion yields the remaining three native sources", () => {
  const policy = resolveM8CrawlerSourcePolicy("fr-conseil-constitutionnel", NATIVE);
  assert.equal(policy.valid, true);
  assert.deepEqual(policy.excluded, ["fr-conseil-constitutionnel"]);
  assert.deepEqual(policy.effective, ["de-bverfg", "us-scotus", "es-tribunal-constitucional"]);
});

test("France and Spain are staged-owned while Germany and US remain M8-owned", () => {
  const policy = resolveM8CrawlerSourcePolicy("fr-conseil-constitutionnel,es-tribunal-constitucional", NATIVE);
  assert.equal(policy.valid, true);
  assert.deepEqual(policy.excluded, ["fr-conseil-constitutionnel", "es-tribunal-constitucional"]);
  assert.deepEqual(policy.effective, ["de-bverfg", "us-scotus"]);
});

test("exclusion config trims, dedupes, and preserves native order", () => {
  const policy = resolveM8CrawlerSourcePolicy(" fr-conseil-constitutionnel , fr-conseil-constitutionnel ", NATIVE);
  assert.equal(policy.valid, true);
  assert.deepEqual(policy.excluded, ["fr-conseil-constitutionnel"]);
  assert.deepEqual(policy.effective, ["de-bverfg", "us-scotus", "es-tribunal-constitucional"]);
});

test("unknown and malformed exclusions fail closed to an empty effective list", () => {
  for (const raw of ["fr-conseil-constitutionel", "de-bverfg,not-a-source", "fr-conseil-constitutionnel,wat", ",,"]) {
    const policy = resolveM8CrawlerSourcePolicy(raw, NATIVE);
    assert.equal(policy.valid, false, `expected invalid for ${JSON.stringify(raw)}`);
    assert.deepEqual(policy.effective, []);
    assert.deepEqual(policy.excluded, []);
    assert.ok(policy.reason && policy.reason.startsWith("m8.crawler_source_exclude_"));
  }
  assert.match(
    resolveM8CrawlerSourcePolicy("wat", NATIVE).reason ?? "",
    /m8\.crawler_source_exclude_unknown:wat/,
  );
});

test("crawler-daily Workflow iterates only effective sources and reports evidence", () => {
  const source = fs.readFileSync(path.join(root, "workers/async-pipeline/src/index.ts"), "utf8");
  assert.match(source, /resolveM8CrawlerSourcePolicy\(this\.env\.M8_CRAWLER_SOURCE_EXCLUDE, NATIVE_CRAWLER_SOURCES\)/u);
  assert.match(source, /event\.payload\.kind === "crawler-daily"[\s\S]*for \(const source of sourcePolicy\.effective/u);
  assert.match(source, /effectiveSources: \[\.\.\.sourcePolicy\.effective\]/u);
  assert.match(source, /excludedSources: \[\.\.\.sourcePolicy\.excluded\]/u);
  assert.match(source, /sourceConfigValid: sourcePolicy\.valid/u);
  assert.match(source, /m8_crawler_source_policy/u);
});

test("/health exposes effective and excluded crawler sources without secrets", () => {
  const source = fs.readFileSync(path.join(root, "workers/async-pipeline/src/index.ts"), "utf8");
  assert.match(source, /crawlerSourceOwnership: \{/u);
  assert.match(source, /nativeSources: \[\.\.\.NATIVE_CRAWLER_SOURCES\]/u);
  assert.match(source, /effectiveSources: crawlerSourcePolicy\.effective/u);
  assert.match(source, /excludedSources: crawlerSourcePolicy\.excluded/u);
  assert.doesNotMatch(source, /M8_CRAWLER_SOURCE_EXCLUDE:/u);
});

test("production worker config gives staged and M8 mutually exclusive source ownership", () => {
  const config = fs.readFileSync(path.join(root, "workers/async-pipeline/wrangler.jsonc"), "utf8");
  assert.match(config, /"M8_CRAWLER_SOURCE_EXCLUDE": "fr-conseil-constitutionnel,es-tribunal-constitucional"/u);
  assert.match(config, /"WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST": "fr-conseil-constitutionnel,es-tribunal-constitucional"/u);
  const parsed = JSON.parse(config) as { vars: Record<string, string> };
  const staged = parsed.vars.WORLDCONS_INGEST_STAGE_SOURCE_ALLOWLIST.split(",");
  const owner = resolveM8CrawlerSourcePolicy(parsed.vars.M8_CRAWLER_SOURCE_EXCLUDE, NATIVE);
  assert.equal(owner.valid, true);
  assert.deepEqual(owner.excluded, staged, "staged discovery sources and M8 exclusions must match exactly");
  assert.deepEqual(owner.effective, ["de-bverfg", "us-scotus"]);
  assert.match(config, /"WORLDCONS_INGEST_STAGE_BOOTSTRAP_LIMIT": "1"/u);
  assert.match(config, /"WORLDCONS_INGEST_STAGE_DISPATCH_LIMIT": "1"/u);
});
