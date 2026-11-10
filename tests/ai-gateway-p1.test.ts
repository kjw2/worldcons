import assert from "node:assert/strict";
import test from "node:test";
import { completeJsonWithMetadata } from "@/lib/ai/client";
import {
  completeGatewaySummaryJson,
  resolveP1GatewaySummary,
  type GatewaySummaryAiBinding,
} from "@/lib/ai/gateway-summary";
import { summarizeArticle } from "@/lib/ai/summarize";

const goodSummary = {
  koreanTitle: "헌법재판 사건 요약",
  originalTitle: "Constitutional decision",
  summary: {
    coreSummary: ["헌법적 쟁점을 심사했습니다."],
    referencedProvisions: [],
    background: "헌법재판이 제기되었습니다.",
    caseStructure: "청구인과 국가기관이 다투었습니다.",
    implications: "헌법적 검토 기준을 정리했습니다.",
    practicalNotes: "공식 원문을 확인해야 합니다.",
  },
  entities: [],
  tags: ["헌법"],
  categories: ["판례"],
  riskFlags: [],
};

const messages = [{ role: "user" as const, content: "JSON을 반환해 주세요." }];
function fakeBinding(response: unknown, calls: unknown[]): GatewaySummaryAiBinding {
  return {
    async run(model, input, options) {
      calls.push({ model, input, options });
      return response;
    },
  };
}

test("P1 only G1 incremental and G2 scheduled jobs opt in; G3/G4 stay direct", () => {
  const calls: unknown[] = [];
  const AI = fakeBinding({}, calls);
  const env = { AI, WORLDCONS_SUMMARY_BACKEND: "cloudflare-ai-gateway" };
  assert.deepEqual(resolveP1GatewaySummary(env, "ingest"), { ai: AI, gatewayId: "default", route: "gemini-flash-fallback" });
  assert.deepEqual(resolveP1GatewaySummary(env, "scheduled"), { ai: AI, gatewayId: "default", route: "gemini-flash-fallback" });
  assert.equal(resolveP1GatewaySummary(env), undefined);
  assert.equal(resolveP1GatewaySummary({ AI }, "ingest"), undefined, "rollback is the default");
  assert.equal(resolveP1GatewaySummary({ AI, WORLDCONS_SUMMARY_BACKEND: "direct-gemini" }, "scheduled"), undefined);
  assert.throws(() => resolveP1GatewaySummary({ WORLDCONS_SUMMARY_BACKEND: "cloudflare-ai-gateway" }, "ingest"), /binding_missing/);
  assert.throws(() => resolveP1GatewaySummary({ AI, WORLDCONS_SUMMARY_BACKEND: "wrong-backend" }, "ingest"), /invalid_backend/);
  assert.equal(calls.length, 0);
});

test("Gateway uses only the four-node dynamic route; no direct provider key or model list", async () => {
  const calls: unknown[] = [];
  const AI = fakeBinding({ id: "chatcmpl-test123", model: "gemini-3.1-flash-lite", usage: { prompt_tokens: 44, completion_tokens: 9 }, choices: [{ message: { content: '{"ok":true}' } }] }, calls);
  const config = resolveP1GatewaySummary({ AI, WORLDCONS_SUMMARY_BACKEND: "cloudflare-ai-gateway" }, "ingest")!;
  const result = await completeJsonWithMetadata(messages, { gateway: config, allowProviderFallback: false });
  assert.equal(result?.provider, "cloudflare-ai-gateway");
  assert.equal(result?.model, "gemini-3.1-flash-lite", "record actual model, not first requested model");
  assert.equal(result?.content, '{"ok":true}');
  assert.equal(result?.requestId, "chatcmpl-test123");
  assert.deepEqual(result?.usage, { promptTokens: 44, completionTokens: 9 });
  assert.deepEqual(calls, [{
    model: "dynamic/gemini-flash-fallback",
    input: { messages, max_tokens: 8192 },
    options: { gateway: { id: "default", skipCache: true } },
  }]);
  assert.equal(JSON.stringify(calls).includes("AIza"), false);
});

test("Gateway validates JSON and fails closed without hidden vendor fallbacks", async () => {
  const cases = [
    [{ choices: [] }, /empty_response/],
    [{ choices: [{ message: { content: "" } }] }, /empty_response/],
    [{ choices: [{ message: { content: "not JSON" } }] }, /invalid_json/],
    [{ choices: [{ message: { content: "[]" } }] }, /invalid_json/],
    [{ message: { content: "{}" } }, /invalid_response/],
  ] as const;
  for (const [response, expected] of cases) {
    const calls: unknown[] = [];
    await assert.rejects(
      completeGatewaySummaryJson(messages, { ai: fakeBinding(response, calls), gatewayId: "default", route: "gemini-flash-fallback" }),
      expected,
    );
    assert.equal(calls.length, 1);
  }
});

test("Provider failure redacts upstream errors including key and source document", async () => {
  const leaked = "AIza-secret-of-user-legal-case-raw-document";
  const ai: GatewaySummaryAiBinding = {
    async run() {
      throw new Error(leaked);
    },
  };
  await assert.rejects(completeGatewaySummaryJson(messages, { ai, gatewayId: "default", route: "gemini-flash-fallback" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "summary_gateway.request_failed");
    assert.equal(error.message.includes(leaked), false);
    return true;
  });
  const config = { ai, gatewayId: "default", route: "gemini-flash-fallback" };
  await assert.rejects(completeJsonWithMetadata(messages, { gateway: config, model: "gemini-3.1-flash-lite" }), /model_override_forbidden/);
  await assert.rejects(completeJsonWithMetadata(messages, { gateway: config, provider: "openai" }), /model_override_forbidden/);
});

test("P1 preserves existing SummarySchema and actual-model provenance metadata", async () => {
  const calls: unknown[] = [];
  const ai = fakeBinding({ model: "gemini-3.5-flash-lite", choices: [{ message: { content: JSON.stringify(goodSummary) } }] }, calls);
  const gateway = { ai, gatewayId: "default", route: "gemini-flash-fallback" };
  const article = {
    sourceKey: "bverfg",
    jurisdiction: "Germany",
    institutionName: "Federal Constitutional Court",
    contentType: "opinion" as const,
    originalUrl: "https://example.org/1",
    canonicalUrl: "https://example.org/1",
    originalLanguage: "de",
    originalTitle: "Constitutional decision",
    cleanedText: "Official decision ".repeat(40),
  };
  const summary = await summarizeArticle(article, { gateway });
  assert.equal(summary.koreanTitle, goodSummary.koreanTitle);
  assert.equal(summary.aiMetadata?.model, "gemini-3.5-flash-lite");
  assert.equal(summary.aiMetadata?.provider, "cloudflare-ai-gateway");
  assert.equal(calls.length, 1);
});

test("Malformed JSON fails closed without an uncontrolled cross-provider retry", async () => {
  let calls = 0;
  const ai: GatewaySummaryAiBinding = {
    async run() {
      calls += 1;
      return { model: "gemini-3.6-flash", choices: [{ message: { content: calls === 1 ? "invalid JSON" : JSON.stringify(goodSummary) } }] };
    },
  };
  const article = {
    sourceKey: "bverfg",
    jurisdiction: "Germany",
    institutionName: "Federal Constitutional Court",
    contentType: "opinion" as const,
    originalUrl: "https://example.org/1",
    canonicalUrl: "https://example.org/1",
    originalLanguage: "de",
    cleanedText: "Official decision ".repeat(40),
  };
  await assert.rejects(summarizeArticle(article, { gateway: { ai, gatewayId: "default", route: "gemini-flash-fallback" } }), /summary_gateway.invalid_json/);
  assert.equal(calls, 1, "malformed Gateway output must fail closed, not invoke another provider");
});
