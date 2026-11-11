import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveSummaryBackend, resolveSummaryGateway, type GatewaySummaryEnv, type SummaryLane } from "@/lib/ai/gateway-summary";
import { resolveNativeAdminSummaryRequest } from "@/workers/async-pipeline/src/admin-job-drain";

const lanes = ["ingest", "scheduled", "admin", "us-private"] as const;
const flags = [
  "WORLDCONS_SUMMARY_BACKEND_G1",
  "WORLDCONS_SUMMARY_BACKEND_G2",
  "WORLDCONS_SUMMARY_BACKEND_G3",
  "WORLDCONS_SUMMARY_BACKEND_G4",
] as const;
const fakeAI = { async run() { return {}; } };

function state(flagsAtGateway: Set<SummaryLane>): GatewaySummaryEnv {
  return {
    AI: fakeAI,
    WORLDCONS_SUMMARY_BACKEND: "direct-gemini",
    WORLDCONS_SUMMARY_BACKEND_G1: flagsAtGateway.has("ingest") ? "cloudflare-ai-gateway" : "direct-gemini",
    WORLDCONS_SUMMARY_BACKEND_G2: flagsAtGateway.has("scheduled") ? "cloudflare-ai-gateway" : "direct-gemini",
    WORLDCONS_SUMMARY_BACKEND_G3: flagsAtGateway.has("admin") ? "cloudflare-ai-gateway" : "direct-gemini",
    WORLDCONS_SUMMARY_BACKEND_G4: flagsAtGateway.has("us-private") ? "cloudflare-ai-gateway" : "direct-gemini",
    WORLDCONS_AI_GATEWAY_ID: "default",
    WORLDCONS_AI_GATEWAY_ROUTE: "gemini-flash-fallback",
  };
}

test("P4 local feature-flag rollout G1 → G4 and explicit reverse rollback G4 → G1 leave no half-migrated lane", () => {
  const enabled = new Set<SummaryLane>();
  for (const lane of lanes) {
    enabled.add(lane);
    const snapshot = state(enabled);
    for (const candidate of lanes) {
      assert.equal(resolveSummaryBackend(snapshot, candidate), enabled.has(candidate) ? "cloudflare-ai-gateway" : "direct-gemini");
      const chosen = resolveSummaryGateway(snapshot, candidate);
      if (enabled.has(candidate)) {
        assert.equal(chosen?.ai, fakeAI);
        assert.equal(chosen?.gatewayId, "default");
        assert.equal(chosen?.route, "gemini-flash-fallback");
      } else assert.equal(chosen, undefined, "direct Gemini is selected explicitly, not a hidden Gateway fallback");
    }
  }
  for (const lane of [...lanes].reverse()) {
    enabled.delete(lane);
    const snapshot = state(enabled);
    for (const candidate of lanes) assert.equal(resolveSummaryGateway(snapshot,candidate) === undefined, !enabled.has(candidate));
  }
  assert.equal(enabled.size, 0);
});

test("P4 only explicit valid backend flags are accepted; missing gateway binding fails closed", () => {
  for (const lane of lanes) {
    const snap=state(new Set([lane]));
    const key=flags[lanes.indexOf(lane)];
    assert.ok(key);
    assert.throws(()=>resolveSummaryBackend({...snap,[key]:"gemini-3.8-flash"},lane),/invalid_backend/);
    assert.throws(()=>resolveSummaryGateway({...snap,AI:undefined},lane),/binding_missing/);
  }
});

test("P4 source config keeps all flags on direct Gemini and includes a future AI binding without deploying", () => {
  const json=readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8");
  const config=JSON.parse(json) as {ai?:{binding:string};vars:Record<string,string>};
  assert.equal(config.ai?.binding,"AI");
  assert.equal(config.vars.WORLDCONS_SUMMARY_BACKEND,"direct-gemini");
  for (const key of flags) assert.equal(config.vars[key],"direct-gemini");
  assert.equal(config.vars.WORLDCONS_AI_GATEWAY_ROUTE,"gemini-flash-fallback");
  assert.equal(config.vars.WORLDCONS_AI_GATEWAY_ID,"default");
});

test("P4 old queued G3 Gateway jobs cannot silently become direct-Gemini after rollback", () => {
  const oldJob={articleId:"case-1",articleSlug:null,options:{provider:"cloudflare-ai-gateway"}};
  const request=resolveNativeAdminSummaryRequest(oldJob);
  assert.equal(request.requestedProvider,"cloudflare-ai-gateway");
  assert.equal(resolveSummaryGateway(state(new Set()),"admin"),undefined);
  // The deployed service explicitly rejects this pre-rollback job rather
  // than silently switching a queued Gateway request to a different provider.
  const workerSource=readFileSync(new URL("../worker/index.ts",import.meta.url),"utf8");
  assert.match(workerSource,/input\.requestedProvider === "cloudflare-ai-gateway" && !gateway/);
  assert.match(workerSource,/summary_gateway\.not_enabled/);
  // Operational rollback therefore requires draining, cancelling or
  // explicitly requeuing old G3 jobs; see the release runbook.
});
