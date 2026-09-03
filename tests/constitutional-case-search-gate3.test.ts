import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = fs.readFileSync(path.join(
  process.cwd(),
  "supabase/migrations/20260903140000_constitutional_case_search_gate3.sql",
), "utf8");

test("Gate 3 search migration uses a single fail-closed read model and identity-first keyset search", () => {
  assert.match(migration, /from public_article_detail_v4 d/);
  assert.match(migration, /case_identifiers_v1_normalized_search_idx/);
  assert.match(migration, /worldcons_query_case_reference_v1/);
  assert.match(migration, /exact-identity/);
  assert.match(migration, /websearch_to_tsquery\('simple'/);
  assert.match(migration, /gate3-exact-lexical-v1/);
  assert.match(migration, /WORLDCONS_CASE_SEARCH_CURSOR_MISMATCH/);
  assert.match(migration, /set statement_timeout = '3000ms'/);
  assert.doesNotMatch(migration, /offset p_offset|p_offset integer/i);
});

test("Gate 3 leaves aliases, semantic retrieval, RRF, and diversification to later gates", () => {
  const ranked = migration.slice(migration.indexOf("create or replace function worldcons_case_search_ranked_v1"));
  assert.doesNotMatch(ranked, /legal_concept_aliases|query_embedding|semantic_similarity|reciprocal|diversif/i);
});
