import { NextResponse } from "next/server";
import { executeAdminCompatibilityCommand } from "@/lib/admin/command-control-plane/compatibility";
import { completeJsonWithMetadata, type LlmMessage } from "@/lib/ai/client";
import { getRuntimeLlmSettings } from "@/lib/ai/llm-settings";
import type { ConfigurableLlmProvider } from "@/lib/ai/llm-settings-types";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import { classifyLlmError } from "@/lib/db/article-triage";
import { redactAdminAuditText } from "@/lib/security/audit-redaction";
import { parseAdminLlmTestBody } from "@/lib/security/admin-api-validation";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

const LLM_HEALTH_MESSAGES: LlmMessage[] = [
  {
    role: "system",
    content: "Return only valid JSON. Keep every string short. Do not include secrets, markdown, or commentary.",
  },
  {
    role: "user",
    content:
      'For a health check, return compact JSON using this shape: {"koreanTitle":"테스트","summary":{"coreSummary":["정상"],"referencedProvisions":[],"background":"테스트","caseStructure":"테스트","implications":"테스트","practicalNotes":"테스트"},"entities":[],"tags":["health"],"categories":["health"],"riskFlags":[]}',
  },
];

function errorMessage(error: unknown) {
  return redactAdminAuditText(error instanceof Error ? error.message : String(error), 500);
}

function parseJsonCompletion(content: string) {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error("LLM health check returned invalid JSON.");
  }
}

async function recordLlmTestAudit({
  request,
  provider,
  model,
  result,
  durationMs,
  error,
  errorClass,
}: {
  request: Request;
  provider: ConfigurableLlmProvider | string;
  model?: string | null;
  result: "ok" | "failed";
  durationMs: number;
  error?: string | null;
  errorClass?: string | null;
}) {
  await recordAdminSiteEvent(
    {
      eventType: "admin_action",
      path: "/api/admin/llm-settings/test",
      metadata: {
        action: "llm_test",
        provider,
        model: model ?? null,
        result,
        errorClass: errorClass ?? null,
        error: error ?? null,
        durationMs,
      },
    },
    request.headers,
  ).catch(() => null);
}

export async function POST(request: Request) {
  const authFailureStatus = adminMutationAuthFailureStatus(request);
  if (authFailureStatus) {
    return NextResponse.json({ error: authFailureStatus === 401 ? "Unauthorized" : "Forbidden" }, { status: authFailureStatus });
  }

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const parsed = parseAdminLlmTestBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid admin LLM test request", detail: parsed.error }, { status: 400 });
  }

  const startedAt = Date.now();
  const { provider } = parsed.data;
  let requestedModel = parsed.data.model;

  try {
    const runtime = await getRuntimeLlmSettings();
    const providerSettings = runtime.providers[provider];
    requestedModel = requestedModel || (runtime.summary.provider === provider ? runtime.summary.model : providerSettings.defaultModel);

    if (!providerSettings.apiKeys.some((key) => key.trim())) {
      throw new Error(`${provider} API key is not configured.`);
    }
    if (provider === "openai-compatible" && !providerSettings.baseUrl?.trim()) {
      throw new Error("OpenAI compatible base URL is required.");
    }

    const compatibility = await executeAdminCompatibilityCommand(
      {
        commandType: "admin.llm.health-check",
        payloadRef: { provider, model: requestedModel ?? null },
        request,
      },
      () => completeJsonWithMetadata(LLM_HEALTH_MESSAGES, { provider, model: requestedModel }),
    );
    const completion = compatibility.value;
    if (!completion) {
      throw new Error("No LLM completion available.");
    }

    parseJsonCompletion(completion.content);
    const durationMs = Date.now() - startedAt;
    await recordLlmTestAudit({
      request,
      provider: completion.provider,
      model: completion.model,
      result: "ok",
      durationMs,
    });

    return NextResponse.json({
      test: {
        status: "ok",
        provider: completion.provider,
        model: completion.model,
        durationMs,
      },
    });
  } catch (error) {
    const message = errorMessage(error);
    const errorClass = classifyLlmError(message);
    const durationMs = Date.now() - startedAt;
    console.warn(`[admin llm-test] ${message}`);
    await recordLlmTestAudit({
      request,
      provider,
      model: requestedModel,
      result: "failed",
      durationMs,
      error: message,
      errorClass,
    });

    return NextResponse.json(
      {
        error: message,
        errorClass,
        test: {
          status: "failed",
          provider,
          model: requestedModel ?? null,
          durationMs,
        },
      },
      { status: 500 },
    );
  }
}
