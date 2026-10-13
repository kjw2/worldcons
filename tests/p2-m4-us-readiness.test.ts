import assert from "node:assert/strict";
import test from "node:test";
import { assertSelectOnly, SECTIONS, checkR2Object, US_SOURCE } from "../scripts/audit-worldcons-p2-m4-us";
import { resolveM8CrawlerSourcePolicy } from "../lib/cloudflare/async-pipeline/crawler-source-ownership";
import { NATIVE_CRAWLER_SOURCES } from "../workers/async-pipeline/src/native-crawler";
import { evaluateUsCutoverReadiness } from "../lib/cloudflare/ingest-stages/us-cutover-readiness";

test("P2-M4 US audit uses only bounded SELECT statements against us-scotus", () => {
  assert.ok(SECTIONS.length >= 3);
  assert.doesNotThrow(() => assertSelectOnly(SECTIONS));
  const combined = SECTIONS.map((section) => section.sql).join("\n");
  assert.match(combined, /us-scotus/);
  assert.doesNotMatch(combined, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA)\b/i);
});

test("P2-M4 US audit refuses a mutating or unbounded statement", () => {
  const mutating = [{ name: "bad", database: "worldcons_core", sql: "UPDATE articles SET status='x' WHERE source_key='us-scotus'" }];
  assert.throws(() => assertSelectOnly(mutating), /p2_m4_us\.non_select/);
  const keyword = [{ name: "bad2", database: "worldcons_core", sql: "SELECT 1 FROM articles LIMIT 1; DELETE FROM articles" }];
  assert.throws(() => assertSelectOnly(keyword), /p2_m4_us\.forbidden_keyword/);
  const unbounded = [{ name: "bad3", database: "worldcons_core", sql: "SELECT * FROM articles" }];
  assert.throws(() => assertSelectOnly(unbounded), /p2_m4_us\.unbounded_query/);
});

test("P2-M4 US audit R2 check rejects an unexpected key shape and never writes", () => {
  const bad = checkR2Object(process.cwd(), "artifacts/article_raw/us-scotus/whatever.json", null);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /p2_m4_us\.r2_key_unexpected/);
});

test("P2-M4 US ownership stays paired: us-scotus remains M8-owned and not staged", () => {
  const policy = resolveM8CrawlerSourcePolicy("fr-conseil-constitutionnel,es-tribunal-constitucional", [...NATIVE_CRAWLER_SOURCES]);
  assert.equal(policy.valid, true);
  assert.ok(policy.effective.includes(US_SOURCE));
  assert.ok(!policy.excluded.includes(US_SOURCE));
});

test("P2-M4 US readiness stays fail-closed without fresh Production evidence", () => {
  const readiness = evaluateUsCutoverReadiness({
    coreArticles: 136,
    publishedP3: 136,
    searchEligible: 136,
  } as never);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.legacyHistoricalCountsOnly, true);
  assert.equal(readiness.blockers[0], "us_cutover.legacy_historical_counts_rejected");
});
