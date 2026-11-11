import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { resolveNativeAdminSummaryRequest } from "@/workers/async-pipeline/src/admin-job-drain";
import { resolveSummaryBackend, resolveSummaryGateway } from "@/lib/ai/gateway-summary";
import { gatewayAdminStatusView, getAdminLlmSettingsView, recordGatewayTestStatus, saveAdminLlmSettings } from "@/lib/ai/llm-settings";
import { clearRuntimeD1Bindings, setRuntimeD1Binding, type D1RuntimePreparedStatement, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { setRuntimeGatewayEnvironment, getRuntimeGatewayEnvironment } from "@/lib/ai/gateway-runtime";
import { parseAdminLlmTestBody, parseAdminReviewBody } from "@/lib/security/admin-api-validation";

const AI = { async run() { return { model: "gemini-3.5-flash-lite", choices: [{ message: { content: "{}" } }] }; } };

test("P2 per-lane flags allow independent G1 G2 G3 G4 rollout and explicit rollback", () => {
  const env = {
    AI,
    WORLDCONS_SUMMARY_BACKEND: "direct-gemini",
    WORLDCONS_SUMMARY_BACKEND_G1: "cloudflare-ai-gateway",
    WORLDCONS_SUMMARY_BACKEND_G2: "direct-gemini",
    WORLDCONS_SUMMARY_BACKEND_G3: "cloudflare-ai-gateway",
    WORLDCONS_SUMMARY_BACKEND_G4: "cloudflare-ai-gateway",
  };
  assert.equal(resolveSummaryBackend(env, "ingest"), "cloudflare-ai-gateway");
  assert.equal(resolveSummaryBackend(env, "scheduled"), "direct-gemini");
  assert.equal(resolveSummaryBackend(env, "admin"), "cloudflare-ai-gateway");
  assert.equal(resolveSummaryBackend(env, "us-private"), "cloudflare-ai-gateway");
  assert.equal(resolveSummaryGateway(env, "scheduled"), undefined);
  assert.deepEqual(resolveSummaryGateway(env, "admin"), { ai: AI, gatewayId: "default", route: "gemini-flash-fallback" });
  assert.deepEqual(resolveSummaryGateway(env, "us-private"), { ai: AI, gatewayId: "default", route: "gemini-flash-fallback" });
  assert.throws(() => resolveSummaryBackend({ WORLDCONS_SUMMARY_BACKEND_G4: "openai" }, "us-private"), /invalid_backend/);
  assert.throws(() => resolveSummaryGateway({ WORLDCONS_SUMMARY_BACKEND_G3: "cloudflare-ai-gateway" }, "admin"), /binding_missing/);
});

test("P2 G3 manual retry only accepts Gemini or the explicit Gateway identifier", () => {
  const job = { articleId: "case-1", articleSlug: null, options: { provider: "cloudflare-ai-gateway" } };
  assert.deepEqual(resolveNativeAdminSummaryRequest(job), {
    articleId: "case-1", slug: undefined, model: undefined,
    source: "admin", requestedProvider: "cloudflare-ai-gateway",
  });
  assert.equal(resolveNativeAdminSummaryRequest({ articleId: null, articleSlug: "slug-1", options: {} }).requestedProvider, "gemini");
  assert.throws(
    () => resolveNativeAdminSummaryRequest({ articleId: "case-1", articleSlug: null, options: { provider: "openai" } }),
    /unsupported_summary_provider/,
  );
});

test("P2 administrator Gateway is a read-only Worker status separate from stored direct-provider keys", () => {
  setRuntimeGatewayEnvironment({
    AI,
    WORLDCONS_SUMMARY_BACKEND_G3: "cloudflare-ai-gateway",
    WORLDCONS_AI_GATEWAY_ID: "default",
    WORLDCONS_AI_GATEWAY_ROUTE: "gemini-flash-fallback",
  });
  try {
    const status = gatewayAdminStatusView({
      status: "ok", checkedAt: "2026-11-11T00:00:00.000Z",
      gatewayId: "default", route: "dynamic/gemini-flash-fallback",
      durationMs: 1420, model: "gemini-3.1-flash-lite",
    });
    assert.equal(status.bindingAvailable, true);
    assert.equal(status.laneBackends.G3, "cloudflare-ai-gateway");
    assert.equal(status.laneBackends.G4, "direct-gemini");
    assert.equal(status.route, "dynamic/gemini-flash-fallback");
    assert.equal(status.lastTest?.model, "gemini-3.1-flash-lite");
    assert.equal(JSON.stringify(status).includes("AIza"), false);
  } finally {
    setRuntimeGatewayEnvironment(null);
  }
});

test("P2 runtime Gateway registry retains only whitelisted configuration and AI binding, not Worker secrets", () => {
  setRuntimeGatewayEnvironment({
    AI,
    WORLDCONS_SUMMARY_BACKEND_G3: "cloudflare-ai-gateway",
    GEMINI_API_KEY: "AIza-top-secret-must-never-be-copied",
    ADMIN_SESSION_SECRET: "admin-internal-secret",
  } as Parameters<typeof setRuntimeGatewayEnvironment>[0] & { GEMINI_API_KEY: string; ADMIN_SESSION_SECRET: string });
  try {
    const state = getRuntimeGatewayEnvironment();
    assert.equal(state.AI, AI);
    assert.equal(state.WORLDCONS_SUMMARY_BACKEND_G3, "cloudflare-ai-gateway");
    assert.equal(JSON.stringify(state).includes("AIza"), false);
    assert.equal(JSON.stringify(state).includes("admin-internal-secret"), false);
  } finally {
    setRuntimeGatewayEnvironment(null);
  }
});

test("P2 Gateway health test request accepts only the explicit provider without a model override", () => {
  const valid = parseAdminLlmTestBody({ provider: "cloudflare-ai-gateway" });
  assert.equal(valid.ok, true);
  const unknown = parseAdminLlmTestBody({ provider: "openai-gateway" });
  assert.equal(unknown.ok, false);
  const malformed = parseAdminLlmTestBody({ provider: "cloudflare-ai-gateway", apiKey: "secret" });
  assert.equal(malformed.ok, false);
  assert.equal(parseAdminReviewBody({
    action: "retry-summary", articleId: "11111111-1111-4111-8111-111111111111",
    provider: "cloudflare-ai-gateway",
  }).ok, true);
});

test("P2 gateway health D1 insert/read/update and admin settings write keep last actual model without raw payloads", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE llm_settings (id TEXT PRIMARY KEY,settings TEXT NOT NULL,created_at TEXT,updated_at TEXT)");
  const binding: D1RuntimeDatabase = {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args: SQLInputValue[] = [];
      const chain: D1RuntimePreparedStatement = {
        bind(...values) { args = values as SQLInputValue[]; return chain; },
        async all<T>() { return { success: true, results: stmt.all(...args) as unknown as T[] }; },
        async run() { stmt.run(...args); return { success: true, meta: { changes: 1 } }; },
      };
      return chain;
    },
  };
  setRuntimeD1Binding("worldcons_ops", binding);
  try {
    const first = {
      status: "ok" as const, checkedAt: "2026-11-11T00:00:00Z", gatewayId: "default",
      route: "dynamic/gemini-flash-fallback", model: "gemini-3.6-flash", durationMs: 2300,
      requestId: "chatcmpl-abc",
    };
    await recordGatewayTestStatus(first);
    assert.equal((await getAdminLlmSettingsView()).gateway.lastTest?.model, "gemini-3.6-flash");
    await recordGatewayTestStatus({ ...first, model: "gemini-3.1-flash-lite", checkedAt: "2026-11-11T00:05:00Z" });
    assert.equal((await getAdminLlmSettingsView()).gateway.lastTest?.model, "gemini-3.1-flash-lite");
    const saved = await saveAdminLlmSettings({ summary: { provider: "gemini", model: "gemini-3.1-flash-lite" } });
    assert.equal(saved.gateway.lastTest?.model, "gemini-3.1-flash-lite");
    assert.equal(saved.summary.provider, "gemini");
    const raw = db.prepare("SELECT settings FROM llm_settings WHERE id='default'").get() as { settings: string };
    assert.equal(raw.settings.includes("chatcmpl-abc"), true);
    assert.equal(raw.settings.includes("AIza"), false);
    assert.equal(raw.settings.includes("Official decision"), false);
  } finally {
    clearRuntimeD1Bindings();
    db.close();
  }
});
