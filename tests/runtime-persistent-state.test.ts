import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createMemoryRuntimeJsonStateStore,
  readRuntimeJsonState,
  setRuntimeJsonStateStore,
  writeRuntimeJsonState,
} from "../lib/runtime/persistent-state";
import { setRuntimePlatform } from "../lib/runtime/platform";

const KEY_SETS = [
  "GEMINI_API_KEY",
  "GEMINI_API_KEYS",
  "GEMINI_AUTO_DISCOVER_MODELS",
  "GEMINI_ROUTER_STATE_PATH",
  "GEMINI_MODEL_CATALOG_PATH",
  "GEMINI_PINNED_MODEL",
  "GEMINI_ALLOW_MODEL_OVERRIDE",
  "GEMINI_SUMMARY_MODEL",
  "GEMINI_SUMMARY_MODELS",
] as const;

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "worldcons-runtime-state-"));
}

function snapshotEnv(keys: readonly string[]) {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(keys: readonly string[], original: Map<string, string | undefined>) {
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("node runtime persists runtime JSON state to an explicit path", () => {
  const dir = scratchDir();
  const explicitPath = path.join(dir, "state.json");
  try {
    setRuntimePlatform(null);
    setRuntimeJsonStateStore(null);
    assert.equal(writeRuntimeJsonState({ fileName: "node-seam-test.json", explicitPath }, { ok: true }), true);
    assert.deepEqual(readRuntimeJsonState({ fileName: "node-seam-test.json", explicitPath }), { ok: true });
    assert.equal(fs.existsSync(explicitPath), true);
  } finally {
    setRuntimeJsonStateStore(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cloudflare worker runtime keeps runtime JSON state in memory and never writes the filesystem", () => {
  const dir = scratchDir();
  const explicitPath = path.join(dir, "state.json");
  try {
    setRuntimeJsonStateStore(null);
    setRuntimePlatform("cloudflare-worker");
    assert.equal(writeRuntimeJsonState({ fileName: "worker-seam-test.json", explicitPath }, { ok: true }), true);
    assert.deepEqual(readRuntimeJsonState({ fileName: "worker-seam-test.json", explicitPath }), { ok: true });
    assert.equal(fs.existsSync(explicitPath), false);
  } finally {
    setRuntimePlatform(null);
    setRuntimeJsonStateStore(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("in-memory store shares one isolate map across registrations", () => {
  try {
    setRuntimePlatform("cloudflare-worker");
    setRuntimeJsonStateStore(createMemoryRuntimeJsonStateStore());
    writeRuntimeJsonState({ fileName: "shared-worker-map-test.json" }, { n: 1 });
    setRuntimeJsonStateStore(createMemoryRuntimeJsonStateStore());
    assert.deepEqual(readRuntimeJsonState({ fileName: "shared-worker-map-test.json" }), { n: 1 });
  } finally {
    setRuntimePlatform(null);
    setRuntimeJsonStateStore(null);
  }
});

test("explicit runtime JSON state store overrides the platform default", () => {
  const calls: string[] = [];
  try {
    setRuntimePlatform(null);
    setRuntimeJsonStateStore({
      read: () => null,
      write: () => {
        calls.push("write");
        return true;
      },
    });
    assert.equal(writeRuntimeJsonState({ fileName: "override-store-test.json" }, 1), true);
    assert.deepEqual(calls, ["write"]);
  } finally {
    setRuntimeJsonStateStore(null);
  }
});

test("gemini router state stays filesystem-free in the cloudflare worker runtime", async () => {
  const dir = scratchDir();
  const explicitPath = path.join(dir, "router-state.json");
  const originalFetch = globalThis.fetch;
  const originalEnv = snapshotEnv(KEY_SETS);
  try {
    for (const key of KEY_SETS) delete process.env[key];
    process.env.GEMINI_API_KEYS = "worker-seam-test-key";
    process.env.GEMINI_AUTO_DISCOVER_MODELS = "false";
    process.env.GEMINI_PINNED_MODEL = "gemini-3.1-flash-lite";
    process.env.GEMINI_ROUTER_STATE_PATH = explicitPath;
    setRuntimePlatform("cloudflare-worker");
    setRuntimeJsonStateStore(createMemoryRuntimeJsonStateStore());

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(":generateContent")) {
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const { completeGeminiJson } = await import("../lib/ai/gemini-router");
    const result = await completeGeminiJson([{ role: "user", content: "요약 테스트" }]);
    assert.equal(result?.provider, "gemini");
    assert.equal(result?.model, "gemini-3.1-flash-lite");
    assert.equal(fs.existsSync(explicitPath), false);
  } finally {
    globalThis.fetch = originalFetch;
    setRuntimePlatform(null);
    setRuntimeJsonStateStore(null);
    restoreEnv(KEY_SETS, originalEnv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
