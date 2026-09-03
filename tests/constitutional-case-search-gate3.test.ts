import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseSearchApiParams } from "../lib/security/public-api-validation";

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

test("Gate 3 API accepts bounded opaque cursors and rejects unsafe cursor characters", () => {
  const accepted = parseSearchApiParams(new URLSearchParams({
    q: "88/2024",mode: "fulltext",cursor: "Abc_123-next",page: "2",pageSize: "10",
  }));
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.data.filters.cursor, "Abc_123-next");

  const rejected = parseSearchApiParams(new URLSearchParams({ q: "88/2024",cursor: "bad+cursor=" }));
  assert.equal(rejected.ok, false);
});

test("Gate 3 app integration carries nextCursor and does not request Gemini embeddings", () => {
  const root = process.cwd();
  const catalogSearch = fs.readFileSync(path.join(root, "lib/search/case-catalog.ts"), "utf8");
  const feed = fs.readFileSync(path.join(root, "components/infinite-article-feed.tsx"), "utf8");
  const plugin = fs.readFileSync(path.join(root, "lib/chatgpt-plugin/server.ts"), "utf8");
  assert.match(catalogSearch, /worldcons_case_search_page_v2/);
  assert.match(catalogSearch, /nextCursor/);
  assert.doesNotMatch(catalogSearch, /createTextEmbedding|query_embedding|Gemini/i);
  assert.match(feed, /pageInfo\.nextCursor/);
  assert.match(feed, /FEED_STORAGE_VERSION = "v2"/);
  assert.match(plugin, /summaryStatus === "reprocessing"/);
});
