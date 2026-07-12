import type { SummaryJson } from "@/lib/db/types";
import { getOpenAIClient } from "@/lib/ai/client";
import { getRuntimeLlmSettings } from "@/lib/ai/llm-settings";

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

export async function createEmbedding(summary: SummaryJson, options: { signal?: AbortSignal } = {}) {
  return createTextEmbedding(embeddingText(summary), options);
}

export async function createTextEmbedding(input: string, options: { signal?: AbortSignal } = {}) {
  const provider = process.env.EMBEDDING_PROVIDER ?? "openai";
  if (provider !== "openai") {
    throw new Error(`Unsupported EMBEDDING_PROVIDER: ${provider}`);
  }

  const runtime = await getRuntimeLlmSettings();
  const apiKey = runtime.providers.openai.apiKeys[0] ?? process.env.OPENAI_API_KEY;
  const client = getOpenAIClient({ apiKey });
  if (!client) {
    return null;
  }

  const response = await client.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    input,
  }, { signal: options.signal });

  return response.data[0]?.embedding ?? null;
}
