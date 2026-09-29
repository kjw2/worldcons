import type { EmbeddingArtifact } from "@/lib/ai/embeddings";
import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import { buildVectorRecordMetadata } from "@/lib/cloudflare/search-vector/metadata";
import { getRuntimeSearchVectorBinding } from "@/lib/cloudflare/d1/runtime-binding";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function summariesMatch(left: string | null, right: string | null) {
  if (left === null || right === null) return left === right;
  try {
    return canonicalJson(JSON.parse(left)) === canonicalJson(JSON.parse(right));
  } catch {
    return false;
  }
}

export function embeddingRpcPayload(articleId: string, artifact: EmbeddingArtifact) {
  return {
    p_article_id: articleId,
    p_provider: artifact.provider,
    p_model: artifact.model,
    p_dimensions: artifact.dimensions,
    p_embedding: artifact.vector,
    p_input_hash: artifact.inputHash,
    p_generated_at: artifact.generatedAt,
  };
}

export async function persistArticleEmbedding(articleId: string, artifact: EmbeddingArtifact) {
  const core = getRuntimeD1Binding("worldcons_core");
  if (!core) throw new Error("D1 core binding is not configured for embedding persistence.");
  if (
    artifact.provider !== "gemini"
    || artifact.model !== "gemini-embedding-001"
    || artifact.dimensions !== 1536
    || artifact.vector.length !== artifact.dimensions
    || !/^[0-9a-f]{64}$/u.test(artifact.inputHash)
    || !Number.isFinite(Date.parse(artifact.generatedAt))
  ) {
    throw new Error("ARTICLE_EMBEDDING_INVALID_INPUT");
  }

  const articleResult = await core.prepare(
    "SELECT id, summary_json FROM articles WHERE id = ?",
  ).bind(articleId).all<{ id: string; summary_json: string | null }>();
  if (articleResult.success === false || articleResult.error) {
    throw new Error(`Failed to read article for Gemini embedding persistence: ${articleResult.error ?? "D1 query failed"}`);
  }
  const article = articleResult.results?.[0];
  if (!article) throw new Error("ARTICLE_EMBEDDING_ARTICLE_NOT_FOUND");

  const versionResult = await core.prepare([
    "SELECT v.id, v.article_id, v.content_hash, v.source_key, v.jurisdiction, v.content_type,",
    "v.original_language, v.original_published_at, v.summary_json",
    "FROM article_publications_p3 p",
    "JOIN article_content_versions_p3 v ON v.id = p.version_id AND v.article_id = p.article_id",
    "WHERE p.article_id = ? AND p.state = 'published'",
  ].join(" ")).bind(articleId).all<{
    id: string;
    article_id: string;
    content_hash: string;
    source_key: string;
    jurisdiction: string;
    content_type: string;
    original_language: string;
    original_published_at: string | null;
    summary_json: string | null;
  }>();
  if (versionResult.success === false || versionResult.error) {
    throw new Error(`Failed to read published article version for Gemini embedding persistence: ${versionResult.error ?? "D1 query failed"}`);
  }
  const version = versionResult.results?.find((candidate) => summariesMatch(candidate.summary_json, article.summary_json));

  const statement = core.prepare([
    "UPDATE articles SET embedding_provider = ?, embedding_model = ?, embedding_dimensions = ?,",
    "embedding_input_hash = ?, embedding_generated_at = ? WHERE id = ?",
  ].join(" ")).bind(
    artifact.provider,
    artifact.model,
    artifact.dimensions,
    artifact.inputHash,
    artifact.generatedAt,
    articleId,
  );
  if (!statement.run) throw new Error("D1 core binding does not support embedding writes.");

  if (version) {
    const vector = getRuntimeSearchVectorBinding();
    if (!vector?.upsert) throw new Error("Vectorize upsert binding is not configured for embedding persistence.");
    const metadata = buildVectorRecordMetadata({
      sourceKey: version.source_key,
      jurisdiction: version.jurisdiction,
      contentType: version.content_type,
      language: version.original_language,
      originalPublishedAt: version.original_published_at,
      articleVersionId: version.id,
      contentHash: version.content_hash,
      provider: artifact.provider,
      model: artifact.model,
      dimensions: artifact.dimensions,
      inputHash: artifact.inputHash,
      generatedAt: artifact.generatedAt,
    });
    await vector.upsert([{ id: articleId, values: [...artifact.vector], metadata: { ...metadata } }]);

    const now = new Date().toISOString();
    const artifactStatement = core.prepare([
      "INSERT INTO article_embedding_artifacts (article_version_id, article_id, content_hash, provider, model,",
      "dimensions, input_hash, generated_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "ON CONFLICT(article_version_id) DO UPDATE SET content_hash = excluded.content_hash,",
      "provider = excluded.provider, model = excluded.model, dimensions = excluded.dimensions,",
      "input_hash = excluded.input_hash, generated_at = excluded.generated_at, updated_at = excluded.updated_at",
    ].join(" ")).bind(
      version.id,
      articleId,
      version.content_hash,
      artifact.provider,
      artifact.model,
      artifact.dimensions,
      artifact.inputHash,
      artifact.generatedAt,
      now,
    );
    if (!artifactStatement.run) throw new Error("D1 core binding does not support embedding artifact writes.");
    const results = await core.batch?.([statement, artifactStatement]);
    if (!results) throw new Error("D1 core binding does not support transactional embedding writes.");
    if (results.some((result) => result.success === false || result.error || result.meta?.changes !== 1)) {
      throw new Error("Failed to persist Gemini embedding provenance to D1.");
    }
  } else {
    const result = await statement.run();
    if (result.success === false || result.error || result.meta?.changes !== 1) {
      throw new Error("Failed to persist Gemini embedding provenance to D1.");
    }
  }
}

export async function tryPersistArticleEmbedding(articleId: string, artifact: EmbeddingArtifact | null | undefined) {
  if (!artifact) return false;
  try {
    await persistArticleEmbedding(articleId, artifact);
    return true;
  } catch (error) {
    console.warn(JSON.stringify({
      event: "worldcons_embedding_persistence_deferred",
      articleId,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    }));
    return false;
  }
}

export const EMPTY_EMBEDDING_FIELDS = {
  embedding: null,
  embedding_provider: null,
  embedding_model: null,
  embedding_dimensions: null,
  embedding_input_hash: null,
  embedding_generated_at: null,
} as const;
