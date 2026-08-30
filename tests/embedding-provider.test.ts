import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { EMBEDDING_DIMENSIONS } from "@/lib/ai/embeddings";

const root = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("embedding width stays pinned to the articles.embedding column", () => {
  // A mismatch here cannot be caught at compile time: pgvector would reject the insert
  // at runtime, so the constant and the migration must be checked against each other.
  const schema = read("supabase/migrations/20260508000000_initial_schema.sql");
  assert.match(schema, new RegExp(`embedding vector\\(${EMBEDDING_DIMENSIONS}\\)`, "u"));

  const search = read("supabase/migrations/20260508001000_search_and_glossary.sql");
  assert.match(search, new RegExp(`query_embedding vector\\(${EMBEDDING_DIMENSIONS}\\)`, "u"));
});

test("Gemini embeddings request the pinned output width", () => {
  const router = read("lib/ai/gemini-router.ts");
  assert.match(router, /:embedContent/u);
  assert.match(router, /outputDimensionality: dimensions/u);
  // A wrong-width vector must fail loudly instead of being persisted.
  assert.match(router, /returned \$\{values\.length\} dimensions, expected \$\{dimensions\}/u);
});

test("embedding provider selection supports Gemini without dropping OpenAI", () => {
  const embeddings = read("lib/ai/embeddings.ts");
  assert.match(embeddings, /provider === "gemini"/u);
  assert.match(embeddings, /createGeminiEmbedding\(/u);
  assert.match(embeddings, /Unsupported EMBEDDING_PROVIDER/u);
  assert.match(embeddings, /text-embedding-3-small/u);
});

test("embedding backfill only writes vectors and resumes after a provider deferral", () => {
  const backlog = read("lib/ingest/embedding-backlog.ts");
  // The backfill must never rewrite summary text; only the vector column.
  assert.match(backlog, /\.update\(\{ embedding: vector \}\)/u);
  // Only one update call may exist, and it must carry the vector alone.
  const updateCalls = backlog.match(/\.update\(/gu) ?? [];
  assert.equal(updateCalls.length, 1);
  // Reading the summary is expected; writing it back is not.
  assert.doesNotMatch(backlog, /update\(\{[^}]*summary_json/u);
  assert.doesNotMatch(backlog, /update\(\{[^}]*status/u);
  // Quota exhaustion is a pause, so the run stops cleanly and stays repeatable.
  assert.match(backlog, /isGlobalSummaryBackoff\(message\)/u);
  assert.match(backlog, /status: "deferred"/u);
  assert.match(backlog, /\.is\("embedding", null\)/u);
});
