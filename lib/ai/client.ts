import OpenAI from "openai";
import { completeGeminiJson } from "@/lib/ai/gemini-router";
import { getRuntimeLlmSettings, type RuntimeLlmProviderSettings } from "@/lib/ai/llm-settings";
import type { ConfigurableLlmProvider } from "@/lib/ai/llm-settings-types";

export type LlmMessage = {
  role: "system" | "user";
  content: string;
};

export type LlmProvider = ConfigurableLlmProvider | "mock";

export interface LlmCompletionOptions {
  provider?: Exclude<LlmProvider, "mock">;
  model?: string;
}

export interface LlmCompletionResult {
  content: string;
  provider: LlmProvider;
  model: string;
}

const cachedOpenAIClients = new Map<string, OpenAI>();

export function hasOpenAiKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function hasGeminiKey() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS);
}

export function getOpenAIClient(options: { apiKey?: string; baseURL?: string } = {}) {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const cacheKey = `${options.baseURL ?? "openai"}:${apiKey.slice(-8)}`;
  const cached = cachedOpenAIClients.get(cacheKey);
  if (cached) return cached;

  const client = new OpenAI({
    apiKey,
    baseURL: options.baseURL,
  });
  cachedOpenAIClients.set(cacheKey, client);
  return client;
}

function providerModel(settings: RuntimeLlmProviderSettings, fallback: string) {
  return settings.defaultModel?.trim() || fallback;
}

function selectedModel(
  provider: Exclude<LlmProvider, "mock">,
  settings: RuntimeLlmProviderSettings,
  runtimeSummary: { provider: ConfigurableLlmProvider; model: string },
  requestedModel: string | undefined,
  fallback: string,
) {
  return requestedModel?.trim() || (runtimeSummary.provider === provider ? runtimeSummary.model?.trim() : "") || providerModel(settings, fallback);
}

function firstApiKey(settings: RuntimeLlmProviderSettings) {
  return settings.apiKeys.find((key) => key.trim()) ?? "";
}

function messagesForOpenAi(messages: LlmMessage[]) {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

function anthropicMessages(messages: LlmMessage[]) {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const user = messages.filter((message) => message.role === "user").map((message) => message.content).join("\n\n");
  return {
    system,
    messages: [
      {
        role: "user",
        content: `${user}\n\nReturn only a valid JSON object. Do not wrap it in markdown.`,
      },
    ],
  };
}

export function supportsOpenAiTemperature(model: string) {
  const normalized = model.trim().toLowerCase();
  if (/^gpt-5(?:[.-]|$)/.test(normalized)) return false;
  if (/^o\d(?:[.-]|$)/.test(normalized)) return false;
  return true;
}

function openAiCompletionPayload(messages: LlmMessage[], model: string, includeTemperature = supportsOpenAiTemperature(model)) {
  return {
    model,
    messages: messagesForOpenAi(messages),
    response_format: { type: "json_object" as const },
    ...(includeTemperature ? { temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0.2) } : {}),
  };
}

function isUnsupportedTemperatureError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("temperature") && (message.includes("unsupported") || message.includes("does not support"));
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: {
    message?: string;
    type?: string;
  };
}

async function completeAnthropicJson(messages: LlmMessage[], model: string, apiKey: string): Promise<LlmCompletionResult | null> {
  if (!apiKey) {
    if (process.env.NODE_ENV === "production") throw new Error("Claude API key is not configured.");
    return null;
  }
  const payload = anthropicMessages(messages);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS ?? 4096),
      temperature: Number(process.env.ANTHROPIC_TEMPERATURE ?? 0.2),
      system: payload.system,
      messages: payload.messages,
    }),
    signal: AbortSignal.timeout(Number(process.env.ANTHROPIC_REQUEST_TIMEOUT_MS ?? 30_000)),
  });

  const responseText = await response.text();
  const data = responseText ? (JSON.parse(responseText) as AnthropicResponse) : {};
  if (!response.ok) {
    const message = data.error?.message ?? responseText;
    throw new Error(`Claude route failed: ${response.status} ${message.slice(0, 500)}`);
  }

  const content = data.content?.map((part) => part.text ?? "").join("").trim() ?? "";
  if (!content) throw new Error("Claude route returned empty text.");
  return {
    content,
    provider: "anthropic",
    model,
  };
}

async function completeOpenAiLikeJson(
  messages: LlmMessage[],
  provider: "openai" | "openai-compatible",
  model: string,
  apiKey: string,
  baseURL?: string,
): Promise<LlmCompletionResult | null> {
  const client = getOpenAIClient({ apiKey, baseURL });
  if (!client) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(provider === "openai" ? "OPENAI_API_KEY is required in production." : "OpenAI compatible API key is required in production.");
    }

    return null;
  }

  let completion: Awaited<ReturnType<typeof client.chat.completions.create>>;
  try {
    completion = await client.chat.completions.create(openAiCompletionPayload(messages, model));
  } catch (error) {
    if (!isUnsupportedTemperatureError(error)) throw error;
    completion = await client.chat.completions.create(openAiCompletionPayload(messages, model, false));
  }

  return {
    content: completion.choices[0]?.message.content ?? "{}",
    provider,
    model,
  };
}

export async function completeJsonWithMetadata(messages: LlmMessage[], options: LlmCompletionOptions = {}): Promise<LlmCompletionResult | null> {
  const runtime = await getRuntimeLlmSettings();
  const provider = options.provider ?? runtime.summary.provider ?? "openai";

  if (provider === "gemini") {
    const gemini = runtime.providers.gemini;
    const model = selectedModel(provider, gemini, runtime.summary, options.model, "gemini-3.1-flash-lite");
    const useRouterModelFallbacks = !options.model && process.env.GEMINI_DISABLE_MODEL_FALLBACKS !== "true";
    return completeGeminiJson(messages, { ...(useRouterModelFallbacks ? {} : { model }), apiKeys: gemini.apiKeys });
  }

  if (provider === "anthropic") {
    const anthropic = runtime.providers.anthropic;
    const model = selectedModel(provider, anthropic, runtime.summary, options.model, "claude-3-5-haiku-latest");
    return completeAnthropicJson(messages, model, firstApiKey(anthropic));
  }

  if (provider === "openai-compatible") {
    const compatible = runtime.providers["openai-compatible"];
    const model = selectedModel(provider, compatible, runtime.summary, options.model, "gpt-4.1-mini");
    if (!compatible.baseUrl) throw new Error("OpenAI compatible base URL is required.");
    return completeOpenAiLikeJson(messages, "openai-compatible", model, firstApiKey(compatible), compatible.baseUrl);
  }

  if (provider !== "openai") {
    throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
  }

  const openai = runtime.providers.openai;
  const model = selectedModel(provider, openai, runtime.summary, options.model, "gpt-4.1-mini");
  const apiKey = firstApiKey(openai) || process.env.OPENAI_API_KEY || "";
  if (!apiKey && process.env.NODE_ENV !== "production") return null;
  return completeOpenAiLikeJson(messages, "openai", model, apiKey);
}

export async function completeJson(messages: LlmMessage[], options: LlmCompletionOptions = {}) {
  const result = await completeJsonWithMetadata(messages, options);
  return result?.content ?? null;
}
