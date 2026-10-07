import OpenAI from "openai";
import { completeGeminiJson } from "@/lib/ai/gemini-router";
import {
  getRuntimeLlmSettings,
  type RuntimeLlmProviderSettings,
  type RuntimeLlmSettings,
} from "@/lib/ai/llm-settings";
import type { ConfigurableLlmProvider } from "@/lib/ai/llm-settings-types";

export type LlmMessage = {
  role: "system" | "user";
  content: string;
};

export type LlmProvider = ConfigurableLlmProvider | "mock";

export interface LlmCompletionOptions {
  provider?: Exclude<LlmProvider, "mock">;
  model?: string;
  apiKeys?: string[];
  providerApiKeys?: Partial<Record<ConfigurableLlmProvider, string[]>>;
  allowProviderFallback?: boolean;
  signal?: AbortSignal;
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

async function completeAnthropicJson(
  messages: LlmMessage[],
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<LlmCompletionResult | null> {
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
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(Number(process.env.ANTHROPIC_REQUEST_TIMEOUT_MS ?? 30_000))])
      : AbortSignal.timeout(Number(process.env.ANTHROPIC_REQUEST_TIMEOUT_MS ?? 30_000)),
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
  signal?: AbortSignal,
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
    completion = await client.chat.completions.create(openAiCompletionPayload(messages, model), { signal });
  } catch (error) {
    if (!isUnsupportedTemperatureError(error)) throw error;
    completion = await client.chat.completions.create(openAiCompletionPayload(messages, model, false), { signal });
  }

  return {
    content: completion.choices[0]?.message.content ?? "{}",
    provider,
    model,
  };
}

const PROVIDER_FALLBACK_ORDER: ConfigurableLlmProvider[] = ["gemini", "openai", "anthropic", "openai-compatible"];

function providerKeys(
  provider: ConfigurableLlmProvider,
  settings: RuntimeLlmProviderSettings,
  options: LlmCompletionOptions,
) {
  const override = options.providerApiKeys?.[provider]?.map((key) => key.trim()).filter(Boolean);
  if (override?.length) return override;
  if (options.apiKeys?.length) return options.apiKeys.map((key) => key.trim()).filter(Boolean);
  return settings.apiKeys;
}

function providerAvailable(
  provider: ConfigurableLlmProvider,
  runtime: RuntimeLlmSettings,
  options: LlmCompletionOptions,
) {
  const settings = runtime.providers[provider];
  const explicitKeys = options.providerApiKeys?.[provider]?.map((key) => key.trim()).filter(Boolean) ?? [];
  if (!settings.enabled && explicitKeys.length === 0) return false;
  if (providerKeys(provider, settings, options).length === 0) return false;
  if (provider === "openai-compatible" && !settings.baseUrl) return false;
  return true;
}

function providerFailureSummary(error: unknown) {
  const typed = error as Error & { status?: number };
  return {
    status: typeof typed?.status === "number" ? typed.status : null,
    message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
  };
}

async function completeWithProvider(
  messages: LlmMessage[],
  provider: ConfigurableLlmProvider,
  options: LlmCompletionOptions,
  runtime: RuntimeLlmSettings | null,
): Promise<LlmCompletionResult | null> {
  if (provider === "gemini") {
    const gemini = runtime?.providers.gemini ?? { enabled: true, defaultModel: "", apiKeys: options.apiKeys ?? [] };
    const summarySettings = runtime?.summary ?? { provider, model: "" };
    const model = selectedModel(provider, gemini, summarySettings, options.model, "gemini-3.1-flash-lite");
    const useRouterModelFallbacks = !options.model && process.env.GEMINI_DISABLE_MODEL_FALLBACKS !== "true";
    return completeGeminiJson(messages, {
      ...(useRouterModelFallbacks ? {} : { model }),
      apiKeys: providerKeys(provider, gemini, options),
      signal: options.signal,
    });
  }

  if (provider === "anthropic") {
    const anthropic = runtime?.providers.anthropic ?? { enabled: true, defaultModel: "", apiKeys: options.apiKeys ?? [] };
    const summarySettings = runtime?.summary ?? { provider, model: "" };
    const model = selectedModel(provider, anthropic, summarySettings, options.model, "claude-3-5-haiku-latest");
    const keys = providerKeys(provider, anthropic, options);
    return completeAnthropicJson(messages, model, keys[0] ?? "", options.signal);
  }

  if (provider === "openai-compatible") {
    const compatible = runtime?.providers["openai-compatible"] ?? { enabled: true, defaultModel: "", apiKeys: options.apiKeys ?? [] };
    const summarySettings = runtime?.summary ?? { provider, model: "" };
    const model = selectedModel(provider, compatible, summarySettings, options.model, "gpt-4.1-mini");
    if (!compatible.baseUrl) throw new Error("OpenAI compatible base URL is required.");
    const keys = providerKeys(provider, compatible, options);
    return completeOpenAiLikeJson(messages, "openai-compatible", model, keys[0] ?? "", compatible.baseUrl, options.signal);
  }

  if (provider !== "openai") {
    throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
  }

  const openai = runtime?.providers.openai ?? { enabled: true, defaultModel: "", apiKeys: options.apiKeys ?? [] };
  const summarySettings = runtime?.summary ?? { provider, model: "" };
  const model = selectedModel(provider, openai, summarySettings, options.model, "gpt-4.1-mini");
  const keys = providerKeys(provider, openai, options);
  const apiKey = keys[0] || process.env.OPENAI_API_KEY || "";
  if (!apiKey && process.env.NODE_ENV !== "production") return null;
  return completeOpenAiLikeJson(messages, "openai", model, apiKey, undefined, options.signal);
}

export async function completeJsonWithMetadata(messages: LlmMessage[], options: LlmCompletionOptions = {}): Promise<LlmCompletionResult | null> {
  const runtime = options.apiKeys ? null : await getRuntimeLlmSettings();
  const provider = options.provider ?? runtime?.summary.provider ?? "openai";
  const providerFallbackEnabled = Boolean(runtime)
    && options.allowProviderFallback !== false
    && process.env.LLM_PROVIDER_FALLBACKS !== "false";

  if (!runtime || !providerFallbackEnabled) {
    return completeWithProvider(messages, provider, options, runtime);
  }

  const order = [provider, ...PROVIDER_FALLBACK_ORDER.filter((candidate) => candidate !== provider)];
  const failures: Array<{ provider: ConfigurableLlmProvider; status: number | null; message: string }> = [];
  for (const candidate of order) {
    if (!providerAvailable(candidate, runtime, options)) continue;
    const candidateOptions: LlmCompletionOptions = candidate === provider
      ? options
      : { ...options, provider: candidate, model: undefined, apiKeys: undefined };
    try {
      const result = await completeWithProvider(messages, candidate, candidateOptions, runtime);
      if (result) return result;
    } catch (error) {
      const failure = providerFailureSummary(error);
      failures.push({ provider: candidate, ...failure });
      console.warn(JSON.stringify({
        event: "llm_provider_failover",
        provider: candidate,
        status: failure.status,
        message: failure.message,
      }));
    }
  }

  throw new Error(`All configured LLM providers failed: ${JSON.stringify(failures)}`);
}

export async function completeJson(messages: LlmMessage[], options: LlmCompletionOptions = {}) {
  const result = await completeJsonWithMetadata(messages, options);
  return result?.content ?? null;
}
