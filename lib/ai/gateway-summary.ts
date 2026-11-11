import type { LlmMessage, LlmCompletionResult } from "@/lib/ai/client";
import { buildRepairPrompt, SUMMARY_SYSTEM_PROMPT } from "@/lib/ai/prompts";

/** Native Workers AI binding. The Gateway owns model selection and BYOK credentials. */
export interface GatewaySummaryAiBinding {
  run(model: string, input: { messages: LlmMessage[]; max_tokens: number }, options: {
    gateway: { id: string; skipCache: boolean };
    extraHeaders?: Record<string, string>;
  }): Promise<unknown>;
}

export interface GatewaySummaryConfig {
  ai: GatewaySummaryAiBinding;
  gatewayId: string;
  route: string;
}

export type SummaryLane = "ingest" | "scheduled" | "admin" | "us-private";
export type SummaryBackend = "direct-gemini" | "cloudflare-ai-gateway";
export type GatewaySummaryEnv = {
  AI?: GatewaySummaryAiBinding;
  WORLDCONS_SUMMARY_BACKEND?: string;
  WORLDCONS_SUMMARY_BACKEND_G1?: string;
  WORLDCONS_SUMMARY_BACKEND_G2?: string;
  WORLDCONS_SUMMARY_BACKEND_G3?: string;
  WORLDCONS_SUMMARY_BACKEND_G4?: string;
  WORLDCONS_AI_GATEWAY_ID?: string;
  WORLDCONS_AI_GATEWAY_ROUTE?: string;
};

const laneFlags: Record<SummaryLane, keyof GatewaySummaryEnv> = {
  ingest: "WORLDCONS_SUMMARY_BACKEND_G1",
  scheduled: "WORLDCONS_SUMMARY_BACKEND_G2",
  admin: "WORLDCONS_SUMMARY_BACKEND_G3",
  "us-private": "WORLDCONS_SUMMARY_BACKEND_G4",
};

/** Read-only backend resolution; P4 may cut over each lane independently. */
export function resolveSummaryBackend(env: GatewaySummaryEnv, lane: SummaryLane): SummaryBackend {
  const backend = String(env[laneFlags[lane]] ?? "").trim() || env.WORLDCONS_SUMMARY_BACKEND?.trim() || "direct-gemini";
  if (backend !== "direct-gemini" && backend !== "cloudflare-ai-gateway") throw new Error("summary_gateway.invalid_backend");
  return backend;
}

/** No work without an explicit lane: avoids silently changing other LLM paths. */
export function resolveSummaryGateway(
  env: GatewaySummaryEnv,
  source?: SummaryLane,
): GatewaySummaryConfig | undefined {
  if (!source) return undefined;
  const backend = resolveSummaryBackend(env, source);
  if (backend === "direct-gemini") return undefined;
  if (!env.AI) throw new Error("summary_gateway.binding_missing");
  return { ai: env.AI, gatewayId: env.WORLDCONS_AI_GATEWAY_ID?.trim() || "default", route: env.WORLDCONS_AI_GATEWAY_ROUTE?.trim() || "gemini-flash-fallback" };
}

/** Keep the existing P1 test/API contract while promoting the shared resolver. */
export const resolveP1GatewaySummary = resolveSummaryGateway;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function completeGatewaySummaryJson(messages: LlmMessage[], config: GatewaySummaryConfig): Promise<LlmCompletionResult> {
  if (!config.ai || !/^[a-zA-Z0-9_-]{1,80}$/.test(config.gatewayId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(config.route)) {
    throw new Error("summary_gateway.invalid_configuration");
  }
  const callGateway = async (prompt: LlmMessage[]): Promise<{ envelope: Record<string, unknown>; content: string }> => {
    let response: unknown;
    try {
      response = await config.ai.run(`dynamic/${config.route}`, { messages: prompt, max_tokens: 8192 }, {
        gateway: { id: config.gatewayId, skipCache: true },
        // Crucial: native env.AI.run otherwise inherits the gateway's payload
        // collection setting and may persist the full judicial source text.
        extraHeaders: { "cf-aig-collect-log-payload": "false" },
      });
    } catch (error) {
      // Never log provider responses, prompts, original text or secrets.
      const status = isRecord(error) && typeof error.status === "number" ? error.status : null;
      throw new Error(`summary_gateway.request_failed${status ? ` ${status}` : ""}`);
    }
    const envelope = isRecord(response) && isRecord(response.result) ? response.result : response;
    if (!isRecord(envelope) || !Array.isArray(envelope.choices)) throw new Error("summary_gateway.invalid_response");
    const choice = envelope.choices[0];
    const message = isRecord(choice) ? choice.message : null;
    const content = isRecord(message) && typeof message.content === "string" ? message.content.trim() : "";
    if (!content) throw new Error("summary_gateway.empty_response");
    return { envelope, content };
  };

  const parseObject = (raw: string): string | null => {
    const content = raw.replace(/^\x60{3}(?:json)?\s*\n?/i, "").replace(/\n?\s*\x60{3}\s*$/, "").trim();
    try {
      return isRecord(JSON.parse(content)) ? content : null;
    } catch {
      return null;
    }
  };

  let { envelope, content } = await callGateway(messages);
  let validJson = parseObject(content);
  if (!validJson) {
    // One bounded JSON repair through the SAME dynamic Gateway, never a
    // provider-specific or application-level DeepSeek/OpenAI fallback.
    const repaired = await callGateway([
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: buildRepairPrompt(content) },
    ]);
    envelope = repaired.envelope;
    validJson = parseObject(repaired.content);
    if (!validJson) throw new Error("summary_gateway.invalid_json");
  }
  content = validJson;
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
