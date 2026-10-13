import assert from "node:assert/strict";
import test from "node:test";
import { assertSelectOnly, SECTIONS } from "../scripts/audit-worldcons-m2-readiness";
import { resolveM8CrawlerSourcePolicy } from "../lib/cloudflare/async-pipeline/crawler-source-ownership";
import { NATIVE_CRAWLER_SOURCES } from "../workers/async-pipeline/src/native-crawler";

test("M2 readiness diagnostic uses only SELECT statements against DE/US sources", () => {
  assert.ok(SECTIONS.length >= 6);
  assert.doesNotThrow(() => assertSelectOnly(SECTIONS));
  const combined = SECTIONS.map((section) => section.sql).join("\n");
  assert.match(combined, /'de-bverfg','us-scotus'/);
  assert.doesNotMatch(combined, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i);
});

test("M2 readiness diagnostic refuses a mutating statement", () => {
  const mutating = [{ name: "bad", database: "worldcons_core", sql: "UPDATE articles SET status='x' WHERE source_key='us-scotus'" }];
  assert.throws(() => assertSelectOnly(mutating), /m2_readiness\.non_select/);
  const keyword = [{ name: "bad2", database: "worldcons_core", sql: "SELECT 1 FROM articles; DELETE FROM articles" }];
  assert.throws(() => assertSelectOnly(keyword), /m2_readiness\.forbidden_keyword/);
});

test("M2 ownership stays paired: DE/US remain M8-owned and FR/ES stay staged", () => {
  const policy = resolveM8CrawlerSourcePolicy("fr-conseil-constitutionnel,es-tribunal-constitucional", [...NATIVE_CRAWLER_SOURCES]);
  assert.equal(policy.valid, true);
  assert.deepEqual(policy.excluded, ["fr-conseil-constitutionnel", "es-tribunal-constitucional"]);
  assert.deepEqual(policy.effective, ["de-bverfg", "us-scotus"]);
  assert.ok(policy.effective.includes("de-bverfg"));
  assert.ok(policy.effective.includes("us-scotus"));
});
