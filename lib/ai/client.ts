import OpenAI from "openai";
import { completeGeminiJson } from "@/lib/ai/gemini-router";

export type LlmMessage = {
  role: "system" | "user";
  content: string;
};

export type LlmProvider = "openai" | "gemini" | "mock";

export interface LlmCompletionResult {
  content: string;
  provider: LlmProvider;
  model: string;
}

let cachedOpenAI: OpenAI | null = null;

export function hasOpenAiKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function hasGeminiKey() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS);
}

export function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  if (!cachedOpenAI) {
    cachedOpenAI = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  return cachedOpenAI;
}

export async function completeJsonWithMetadata(messages: LlmMessage[]): Promise<LlmCompletionResult | null> {
  const provider = process.env.LLM_PROVIDER ?? "openai";

  if (provider === "gemini") {
    return completeGeminiJson(messages);
  }

  if (provider !== "openai") {
    throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
  }

  const client = getOpenAIClient();
  if (!client) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("OPENAI_API_KEY is required in production.");
    }

    return null;
  }

  const model = process.env.OPENAI_SUMMARY_MODEL ?? "gpt-4.1-mini";
  const completion = await client.chat.completions.create({
    model,
    messages,
    response_format: { type: "json_object" },
    temperature: 0.2,
  });

  return {
    content: completion.choices[0]?.message.content ?? "{}",
    provider: "openai",
    model,
  };
}

export async function completeJson(messages: LlmMessage[]) {
  const result = await completeJsonWithMetadata(messages);
  return result?.content ?? null;
}
