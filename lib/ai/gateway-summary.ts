import type { LlmMessage, LlmCompletionResult } from "@/lib/ai/client";

/** Native Workers AI binding. The Gateway owns model selection and BYOK credentials. */
export interface GatewaySummaryAiBinding {
  run(model: string, input: { messages: LlmMessage[]; max_tokens: number }, options: { gateway: { id: string; skipCache: boolean } }): Promise<unknown>;
}

export interface GatewaySummaryConfig {
  ai: GatewaySummaryAiBinding;
  gatewayId: string;
  route: string;
}

/** Only P1 G1/G2 service calls may opt in. Default remains direct Gemini. */
export function resolveP1GatewaySummary(
  env: { AI?: GatewaySummaryAiBinding; WORLDCONS_SUMMARY_BACKEND?: string; WORLDCONS_AI_GATEWAY_ID?: string; WORLDCONS_AI_GATEWAY_ROUTE?: string },
  source?: "ingest" | "scheduled",
): GatewaySummaryConfig | undefined {
  if (source !== "ingest" && source !== "scheduled") return undefined;
  const backend = env.WORLDCONS_SUMMARY_BACKEND?.trim() || "direct-gemini";
  if (backend === "direct-gemini") return undefined;
  if (backend !== "cloudflare-ai-gateway") throw new Error("summary_gateway.invalid_backend");
  if (!env.AI) throw new Error("summary_gateway.binding_missing");
  return { ai: env.AI, gatewayId: env.WORLDCONS_AI_GATEWAY_ID?.trim() || "default", route: env.WORLDCONS_AI_GATEWAY_ROUTE?.trim() || "gemini-flash-fallback" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function completeGatewaySummaryJson(messages: LlmMessage[], config: GatewaySummaryConfig): Promise<LlmCompletionResult> {
  if (!config.ai || !/^[a-zA-Z0-9_-]{1,80}$/.test(config.gatewayId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(config.route)) {
    throw new Error("summary_gateway.invalid_configuration");
  }
  let response: unknown;
  try {
    response = await config.ai.run(`dynamic/${config.route}`, { messages, max_tokens: 8192 }, {
      gateway: { id: config.gatewayId, skipCache: true },
    });
  } catch (error) {
    // Do not persist upstream payloads or credentials in D1 error metadata.
    const status = isRecord(error) && typeof error.status === "number" ? error.status : null;
    throw new Error(`summary_gateway.request_failed${status ? ` ${status}` : ""}`);
  }
  const envelope = isRecord(response) && isRecord(response.result) ? response.result : response;
  if (!isRecord(envelope) || !Array.isArray(envelope.choices)) throw new Error("summary_gateway.invalid_response");
  const choice = envelope.choices[0];
  const message = isRecord(choice) ? choice.message : null;
  const content = isRecord(message) && typeof message.content === "string" ? message.content.trim() : "";
  if (!content) throw new Error("summary_gateway.empty_response");
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error("summary_gateway.invalid_json"); }
  if (!isRecord(parsed)) throw new Error("summary_gateway.invalid_json");
  const model = typeof envelope.model === "string" && envelope.model.trim() ? envelope.model.trim() : "unknown";
  const usage = isRecord(envelope.usage) ? envelope.usage : {};
  const promptTokens = typeof usage.prompt_tokens === "number" && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : undefined;
  const completionTokens = typeof usage.completion_tokens === "number" && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : undefined;
  const requestId = typeof envelope.id === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(envelope.id) ? envelope.id : undefined;
  const upstreamProvider = typeof envelope.provider === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(envelope.provider) ? envelope.provider : undefined;
  return {
    content, provider: "cloudflare-ai-gateway", model,
    ...(requestId ? { requestId } : {}),
    ...(upstreamProvider ? { upstreamProvider } : {}),
    ...(promptTokens !== undefined || completionTokens !== undefined ? { usage: { promptTokens, completionTokens } } : {}),
  };
}
