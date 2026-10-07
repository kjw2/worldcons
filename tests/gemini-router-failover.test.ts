import assert from "node:assert/strict";
import test from "node:test";
import { completeGeminiJson } from "../lib/ai/gemini-router";
import { completeJsonWithMetadata } from "../lib/ai/client";
import {
  setRuntimeJsonStateStore,
  type RuntimeJsonStateRef,
  type RuntimeJsonStateStore,
} from "../lib/runtime/persistent-state";

function isolatedStateStore(): RuntimeJsonStateStore {
  const state = new Map<string, unknown>();
  return {
    read<T>(ref: RuntimeJsonStateRef) {
      return (state.get(ref.fileName) ?? null) as T | null;
    },
    write(ref: RuntimeJsonStateRef, value: unknown) {
      state.set(ref.fileName, value);
      return true;
    },
  };
}

async function withRouterTest(
  callback: (calls: string[]) => Promise<void>,
  firstStatus: number,
  firstBody: string,
) {
  const originalFetch = globalThis.fetch;
  const originalAutoDiscover = process.env.GEMINI_AUTO_DISCOVER_MODELS;
  const originalStrategy = process.env.GEMINI_SELECTION_STRATEGY;
  const calls: string[] = [];

  process.env.GEMINI_AUTO_DISCOVER_MODELS = "false";
  process.env.GEMINI_SELECTION_STRATEGY = "GenerationFirstStrategy";
  setRuntimeJsonStateStore(isolatedStateStore());

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("gemini-9.9-flash-lite")) {
      return new Response(firstBody, {
        status: firstStatus,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("gemini-9.8-flash-lite")) {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected Gemini route: ${url}`);
  }) as typeof fetch;

  try {
    await callback(calls);
  } finally {
    globalThis.fetch = originalFetch;
    setRuntimeJsonStateStore(null);
    if (originalAutoDiscover === undefined) delete process.env.GEMINI_AUTO_DISCOVER_MODELS;
    else process.env.GEMINI_AUTO_DISCOVER_MODELS = originalAutoDiscover;
    if (originalStrategy === undefined) delete process.env.GEMINI_SELECTION_STRATEGY;
    else process.env.GEMINI_SELECTION_STRATEGY = originalStrategy;
  }
}

test("Gemini generation falls back to the next model when the newest route is unavailable", async () => {
  await withRouterTest(async (calls) => {
    const result = await completeGeminiJson(
      [{ role: "user", content: "요약" }],
      {
        models: ["gemini-9.9-flash-lite", "gemini-9.8-flash-lite"],
        apiKeys: ["test-key"],
      },
    );

    assert.equal(result?.model, "gemini-9.8-flash-lite");
    assert.equal(calls.length, 2);
    assert.match(calls[0], /gemini-9\.9-flash-lite:generateContent/);
    assert.match(calls[1], /gemini-9\.8-flash-lite:generateContent/);
  }, 404, JSON.stringify({ error: { message: "model not found" } }));
});

test("Gemini generation falls back to the next model on quota throttling", async () => {
  await withRouterTest(async (calls) => {
    const result = await completeGeminiJson(
      [{ role: "user", content: "요약" }],
      {
        models: ["gemini-9.9-flash-lite", "gemini-9.8-flash-lite"],
        apiKeys: ["test-key"],
      },
    );

    assert.equal(result?.model, "gemini-9.8-flash-lite");
    assert.equal(calls.length, 2);
  }, 429, JSON.stringify({ error: { message: "requests per minute exceeded; retry in 60s" } }));
});

test("summary completion falls back from exhausted Gemini routes to another configured provider", async () => {
  const originalFetch = globalThis.fetch;
  const originalAutoDiscover = process.env.GEMINI_AUTO_DISCOVER_MODELS;
  const originalProviderFallbacks = process.env.LLM_PROVIDER_FALLBACKS;
  const calls: string[] = [];

  process.env.GEMINI_AUTO_DISCOVER_MODELS = "false";
  process.env.LLM_PROVIDER_FALLBACKS = "true";
  setRuntimeJsonStateStore(isolatedStateStore());

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(JSON.stringify({ error: { message: "requests per minute exceeded" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("api.anthropic.com/v1/messages")) {
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "{\"ok\":true}" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected provider route: ${url}`);
  }) as typeof fetch;

  try {
    const result = await completeJsonWithMetadata(
      [{ role: "user", content: "요약" }],
      {
        provider: "gemini",
        providerApiKeys: {
          gemini: ["test-gemini-key"],
          anthropic: ["test-anthropic-key"],
        },
        allowProviderFallback: true,
      },
    );
    assert.equal(result?.provider, "anthropic");
    assert.equal(result?.model, "claude-3-5-haiku-latest");
    assert.ok(calls.some((url) => url.includes("generativelanguage.googleapis.com")));
    assert.ok(calls.some((url) => url.includes("api.anthropic.com/v1/messages")));
  } finally {
    globalThis.fetch = originalFetch;
    setRuntimeJsonStateStore(null);
    if (originalAutoDiscover === undefined) delete process.env.GEMINI_AUTO_DISCOVER_MODELS;
    else process.env.GEMINI_AUTO_DISCOVER_MODELS = originalAutoDiscover;
    if (originalProviderFallbacks === undefined) delete process.env.LLM_PROVIDER_FALLBACKS;
    else process.env.LLM_PROVIDER_FALLBACKS = originalProviderFallbacks;
  }
});
