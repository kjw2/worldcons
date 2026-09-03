import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = fs.readFileSync(path.join(
  process.cwd(),
  "supabase/migrations/20260903150000_constitutional_case_multilingual_search_gate4.sql",
), "utf8");

test("Gate 4 versions and freezes reviewed multilingual legal aliases", () => {
  assert.match(migration, /create table legal_concept_alias_sets_v1/);
  assert.match(migration, /create table legal_concepts_v1/);
  assert.match(migration, /create table legal_concept_aliases_v1/);
  assert.match(migration, /language in \('ko','en','de','fr','es'\)/);
  assert.match(migration, /WORLDCONS_REVIEWED_ALIAS_SET_IMMUTABLE/);
  assert.match(migration, /content_hash/);
  assert.match(migration, /review_status='approved'/);
});

test("Gate 4 bounds expansion and fusion before deterministic pagination", () => {
  assert.match(migration, /limit 5/);
  assert.match(migration, /concept_alias_rank<=8/);
  assert.match(migration, /limit 12/);
  assert.ok([...migration.matchAll(/limit 50/g)].length >= 2);
  assert.match(migration, /limit 250/);
  assert.match(migration, /2\.0::double precision\/\(60\+branch_rank\)/);
  assert.match(migration, /max\(1\.0::double precision\/\(60\+branch_rank\)/);
  assert.match(migration, /jurisdiction_rank<=2 then 1\.0 else 0\.92/);
  assert.match(migration, /gate4-multilingual-rrf-v1:/);
  assert.match(migration, /WORLDCONS_CASE_SEARCH_CURSOR_RANKING_VERSION_EXPIRED/);
  assert.doesNotMatch(migration, /offset p_offset|p_offset integer/i);
});

test("Gate 4 keeps identity absolute and does not introduce semantic or Gemini work", () => {
  assert.match(migration, /when exists\(select 1 from exact_candidates\) then 'exact-identity'/);
  assert.match(migration, /where \(select mode from strategy\)='exact-identity'/);
  assert.doesNotMatch(migration, /query_embedding|semantic_similarity|createTextEmbedding|Gemini/i);
});
