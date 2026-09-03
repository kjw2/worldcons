import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { caseCatalogFlagErrors, caseCatalogPublicReadsEnabled, caseCatalogWriteEnabled } from "../lib/case-catalog/flags";

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
  assert.match(sql, /ARTICLE_CATALOG_STALE_DIRECT_WRITE_FORBIDDEN/);
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
  assert.match(sql, /p_content_snapshot jsonb default null/);
  assert.doesNotMatch(publisher, /update articles set\s+jurisdiction=/);
});

test("Catalog rollout flags enforce the P3 -> public -> search -> plugin dependency chain", () => {
  assert.equal(caseCatalogWriteEnabled({ CASE_CATALOG_WRITE_ENABLED: "true" }), true);
  assert.equal(caseCatalogPublicReadsEnabled({
    ADMIN_PUBLICATION_V4_READ_ENABLED: "true",
    CASE_CATALOG_PUBLIC_ENABLED: "true",
  }), true);
  assert.deepEqual(caseCatalogFlagErrors({ CASE_CATALOG_PUBLIC_ENABLED: "true" }), [
    "CASE_CATALOG_PUBLIC_ENABLED requires ADMIN_PUBLICATION_V4_READ_ENABLED",
  ]);
  assert.deepEqual(caseCatalogFlagErrors({
    ADMIN_PUBLICATION_V4_READ_ENABLED: "true",
    CASE_CATALOG_PLUGIN_ENABLED: "true",
  }), ["CASE_CATALOG_PLUGIN_ENABLED requires CASE_CATALOG_SEARCH_ENABLED"]);
  assert.equal(caseCatalogPublicReadsEnabled({ CASE_CATALOG_PUBLIC_ENABLED: "true" }), false);
});

test("public detail renders source-only and stale-reprocessing states while admin withdraw preserves the publication version", () => {
  const detailPage = fs.readFileSync(path.join(process.cwd(), "app/articles/[slug]/(detail)/page.tsx"), "utf8");
  const adminRoute = fs.readFileSync(path.join(process.cwd(), "app/api/admin/work/[kind]/[id]/route.ts"), "utf8");
  const queries = fs.readFileSync(path.join(process.cwd(), "lib/db/queries.ts"), "utf8");
  assert.match(detailPage, /공식 원문이 갱신되어 한국어 요약을 재처리하고 있습니다/);
  assert.match(detailPage, /검증된 공식 판례가 먼저 공개되었습니다/);
  assert.match(adminRoute, /action === "withdraw" \? String\(publication\.version_id\) : String\(head\.current_version_id\)/);
  assert.match(queries, /public_article_detail_v4/);
  assert.match(queries, /summaryAvailable/);
});
