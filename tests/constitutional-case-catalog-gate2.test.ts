import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260903130000_constitutional_case_catalog_gate2.sql",
);
const sql = fs.readFileSync(migrationPath, "utf8");

test("Gate 2 migration fixes identity, source-anchor, head, and stale-enrichment contracts", () => {
  assert.match(sql, /case_identifiers_v1_decision_unique_idx/);
  assert.match(sql, /where identifier_type in \('source_record_id','ecli','hj_id','reporter_citation'\)/);
  assert.match(sql, /case_identifiers_v1_proceeding_lookup_idx/);
  assert.match(sql, /article_revision_heads_v4/);
  assert.match(sql, /article_p3_candidate_select_v4/);
  assert.match(sql, /ARTICLE_P3_WITHDRAW_VERSION_CHANGED/);
  assert.match(sql, /source_anchor_version_id, article_id/);
  assert.match(sql, /ARTICLE_VERSION_AUTHORITATIVE_SELF_ANCHOR_REQUIRED/);
  assert.match(sql, /ARTICLE_VERSION_ENRICHMENT_ANCHOR_INVALID/);
  assert.match(sql, /SOURCE_POLICY_REVIEW_OVERDUE/);
  assert.match(sql, /public_case_catalog_projection_v1/);
  assert.match(sql, /public_article_detail_v4/);
  assert.match(sql, /null::text as raw_text/);
  assert.match(sql, /null::jsonb as error_metadata/);
});

test("Catalog publication remains Gemini-free and cannot expose AI fields from an authoritative row", () => {
  const publisher = sql.slice(sql.indexOf("create or replace function case_catalog_publish_backfill_item_v1"));
  assert.doesNotMatch(publisher, /gemini|generateContent|embedding provider/i);
  assert.match(sql, /new\.summary_json is not null/);
  assert.match(sql, /new\.korean_title is not null/);
  assert.match(sql, /new\.embedding is not null/);
});
