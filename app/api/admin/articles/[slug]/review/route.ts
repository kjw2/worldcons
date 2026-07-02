import { NextResponse } from "next/server";
import { getAdminLlmSettingsView } from "@/lib/ai/llm-settings";
import type { AdminLlmSettingsView, ConfigurableLlmProvider } from "@/lib/ai/llm-settings-types";
import { hasGeminiKey, hasOpenAiKey } from "@/lib/ai/client";
import { getGeminiModels } from "@/lib/ai/gemini-router";
import { getArticleBySlug } from "@/lib/db/queries";
import { parseSlugParam, publicApiValidationErrorResponse } from "@/lib/security/public-api-validation";
import { createAdminCsrfToken, isAuthorizedRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface SummaryModelOption {
  provider: ConfigurableLlmProvider;
  model: string;
  label: string;
}

function providerForModel(model: string): SummaryModelOption["provider"] {
  if (/^claude-/i.test(model)) return "anthropic";
  if (/^gemini-/i.test(model)) return "gemini";
  return /^gpt-|^o\d|^chatgpt-/i.test(model) ? "openai" : "gemini";
}

function providerLabel(provider: ConfigurableLlmProvider) {
  if (provider === "gemini") return "Gemini";
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Claude";
  return "OpenAI Compatible";
}

function pushModelOption(options: SummaryModelOption[], provider: ConfigurableLlmProvider, model?: string | null) {
  const normalized = model?.trim();
  if (!normalized || options.some((option) => option.provider === provider && option.model === normalized)) return;
  options.push({ provider, model: normalized, label: `${providerLabel(provider)} · ${normalized}` });
}

function uniqueText(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]));
}

function summaryModelOptions(currentModel?: string | null, llmSettings?: AdminLlmSettingsView | null): SummaryModelOption[] {
  const options: SummaryModelOption[] = [];

  if (llmSettings) {
    pushModelOption(options, llmSettings.summary.provider, llmSettings.summary.model);
    for (const provider of ["gemini", "openai", "anthropic", "openai-compatible"] as const) {
      const providerSettings = llmSettings.providers[provider];
      if (providerSettings.enabled && providerSettings.hasUsableKey) {
        pushModelOption(options, provider, providerSettings.defaultModel);
      }
    }
  }

  if (hasGeminiKey()) {
    for (const model of getGeminiModels("Summarize").slice(0, 12)) {
      pushModelOption(options, "gemini", model);
    }
  }

  if (hasOpenAiKey()) {
    for (const model of uniqueText([process.env.OPENAI_SUMMARY_MODEL, "gpt-4.1-mini", "gpt-4.1"])) {
      pushModelOption(options, "openai", model);
    }
  }

  if (currentModel && currentModel !== "development-fallback" && !options.some((option) => option.model === currentModel)) {
    const provider = providerForModel(currentModel);
    options.unshift({ provider, model: currentModel, label: `현재 모델 · ${currentModel}` });
  }

  return options;
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { slug } = await params;
  const parsed = parseSlugParam(slug);
  if (!parsed.ok) return publicApiValidationErrorResponse(parsed.error);

  const article = await getArticleBySlug(parsed.data, { includeUnpublished: true, includeSourceText: true });
  if (!article) {
    return NextResponse.json({ error: "Article not found" }, { status: 404 });
  }

  const llmSettings = await getAdminLlmSettingsView().catch(() => null);
  const csrfToken = (await createAdminCsrfToken()) ?? "";
  const currentModel = article.summaryJson?.aiMetadata?.model ?? null;

  return NextResponse.json({
    article,
    csrfToken,
    llmSettings,
    modelOptions: summaryModelOptions(currentModel, llmSettings),
  });
}
