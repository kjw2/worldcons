import { createHash } from "node:crypto";
import type { SummaryJson } from "@/lib/db/types";
import { getRuntimeLlmSettings } from "@/lib/ai/llm-settings";
import { createGeminiEmbeddingResult } from "@/lib/ai/gemini-router";

// Both articles.embedding and article_content_versions_p3.embedding are
// vector(1536). Search and persistence reject every other width.
export const EMBEDDING_DIMENSIONS = 1536;
export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";

export interface EmbeddingArtifact {
  vector: number[];
  provider: "gemini";
  model: string;
  dimensions: typeof EMBEDDING_DIMENSIONS;
  inputHash: string;
  generatedAt: string;
}

export function embeddingText(summary: SummaryJson) {
  return [
    summary.koreanTitle,
    ...summary.summary.coreSummary,
    summary.summary.background,
    summary.summary.implications,
    ...summary.tags,
    ...summary.entities.map((entity) => `${entity.type}: ${entity.normalizedName}`),
  ].join("\n");
}

function configuredProvider() {
  const provider = process.env.EMBEDDING_PROVIDER?.trim().toLowerCase() || "gemini";
  if (provider !== "gemini") {
    throw new Error(`Unsupported EMBEDDING_PROVIDER: ${provider}. WorldCons embeddings are Gemini-only.`);
  }
}

export async function createEmbeddingArtifact(summary: SummaryJson, options: { signal?: AbortSignal } = {}) {
  return createTextEmbeddingArtifact(embeddingText(summary), {
    ...options,
    taskType: "RETRIEVAL_DOCUMENT",
  });
}

export async function createTextEmbeddingArtifact(
  input: string,
  options: { signal?: AbortSignal; taskType?: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" | "SEMANTIC_SIMILARITY" } = {},
): Promise<EmbeddingArtifact | null> {
  configuredProvider();
  const runtime = await getRuntimeLlmSettings();
  const result = await createGeminiEmbeddingResult(input, {
    apiKeys: runtime.providers.gemini.apiKeys,
    model: process.env.GEMINI_EMBEDDING_MODEL?.trim() || DEFAULT_GEMINI_EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    taskType: options.taskType ?? "SEMANTIC_SIMILARITY",
    signal: options.signal,
  });
  if (!result) return null;

  return {
    vector: result.vector,
    provider: "gemini",
    model: result.model,
    dimensions: EMBEDDING_DIMENSIONS,
    inputHash: createHash("sha256").update(input, "utf8").digest("hex"),
    generatedAt: new Date().toISOString(),
  };
}

export async function createEmbedding(summary: SummaryJson, options: { signal?: AbortSignal } = {}) {
  const artifact = await createEmbeddingArtifact(summary, options);
  return artifact?.vector ?? null;
}

export async function createTextEmbedding(input: string, options: { signal?: AbortSignal } = {}) {
  const artifact = await createTextEmbeddingArtifact(input, options);
  return artifact?.vector ?? null;
}
