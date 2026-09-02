import type { EmbeddingArtifact } from "@/lib/ai/embeddings";
import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";

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
  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) throw new Error("Supabase service role is not configured for embedding persistence.");

  const { data, error } = await supabase.rpc("article_embedding_write_v1", embeddingRpcPayload(articleId, artifact));
  if (error) throw new Error(`Failed to persist Gemini embedding: ${error.message}`);
  if (data !== true) throw new Error("Gemini embedding persistence did not confirm the write.");
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
