import type { SummaryJson } from "@/lib/db/types";
import { getOpenAIClient } from "@/lib/ai/client";

function embeddingText(summary: SummaryJson) {
  return [
    summary.koreanTitle,
    ...summary.summary.coreSummary,
    summary.summary.background,
    summary.summary.implications,
    ...summary.tags,
    ...summary.entities.map((entity) => `${entity.type}: ${entity.normalizedName}`),
  ].join("\n");
}

export async function createEmbedding(summary: SummaryJson) {
  return createTextEmbedding(embeddingText(summary));
}

export async function createTextEmbedding(input: string) {
  const provider = process.env.EMBEDDING_PROVIDER ?? "openai";
  if (provider !== "openai") {
    throw new Error(`Unsupported EMBEDDING_PROVIDER: ${provider}`);
  }

  const client = getOpenAIClient();
  if (!client) {
    return null;
  }

  const response = await client.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    input,
  });

  return response.data[0]?.embedding ?? null;
}
