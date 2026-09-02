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
  assert.match(router, /normalizeEmbeddingVector\(values, dimensions\)/u);
  assert.match(router, /taskType/u);
});

test("embedding provider selection is Gemini-only", () => {
  const embeddings = read("lib/ai/embeddings.ts");
  assert.match(embeddings, /provider !== "gemini"/u);
  assert.match(embeddings, /createGeminiEmbeddingResult\(/u);
  assert.match(embeddings, /Unsupported EMBEDDING_PROVIDER/u);
  assert.doesNotMatch(embeddings, /text-embedding-3-small/u);
});

test("an unset embedding provider defaults to Gemini rather than OpenAI", () => {
  // An OpenAI default produced no vectors at all when no OpenAI key was configured,
  // and the failure was swallowed, so summaries saved without embeddings.
  const embeddings = read("lib/ai/embeddings.ts");
  assert.match(embeddings, /process\.env\.EMBEDDING_PROVIDER\?\.trim\(\)\.toLowerCase\(\) \|\| "gemini"/u);
  assert.doesNotMatch(embeddings, /EMBEDDING_PROVIDER \?\? "openai"/u);
});

test("scheduled workflows embed with Gemini when the secret is unset", () => {
  // Every workflow that can write embeddings must agree on the provider, otherwise a
  // single unset secret reintroduces silently missing vectors.
  const workflows = [
    ".github/workflows/summary-drain.yml",
    ".github/workflows/crawlee-worker.yml",
    ".github/workflows/admin-job-worker.yml",
    ".github/workflows/admin-command-worker-p1.yml",
  ];

  for (const workflow of workflows) {
    const source = read(workflow);
    assert.match(source, /EMBEDDING_PROVIDER: gemini/u, workflow);
    assert.match(source, /GEMINI_EMBEDDING_MODEL: \$\{\{ vars\.GEMINI_EMBEDDING_MODEL \|\| .gemini-embedding-001. \}\}/u, workflow);
  }
});

test("embedding backfill uses the provenance RPC and resumes after a provider deferral", () => {
  const backlog = read("lib/ingest/embedding-backlog.ts");
  assert.match(backlog, /persistArticleEmbedding\(row\.id, artifact\)/u);
  assert.doesNotMatch(backlog, /\.from\("articles"\)\.update/u);
  assert.match(backlog, /embedding_provider\.is\.null/u);
  assert.match(backlog, /embedding_model\.is\.null/u);
  // Quota exhaustion is a pause, so the run stops cleanly and stays repeatable.
  assert.match(backlog, /isGlobalSummaryBackoff\(message\)/u);
  assert.match(backlog, /status: "deferred"/u);
});

test("Gemini provenance preserves immutable P3 versions through a derived artifact", () => {
  const migration = read("supabase/migrations/20260831130000_gemini_embedding_provenance.sql");
  assert.match(migration, /create table if not exists article_embedding_artifacts/u);
  assert.match(migration, /create or replace function article_embedding_write_v1/u);
  assert.match(migration, /create or replace function article_embedding_readiness_v1/u);
  assert.match(migration, /v\.summary_json is not distinct from v_article\.summary_json/u);
  assert.match(migration, /coalesce\(e\.embedding, v\.embedding\) as embedding/u);
  assert.doesNotMatch(migration, /update article_content_versions_p3/u);
  assert.match(migration, /grant execute on function article_embedding_write_v1/u);
  assert.match(migration, /missingPublishedArtifactCount/u);
});
