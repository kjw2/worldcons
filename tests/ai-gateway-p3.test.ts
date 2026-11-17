import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolveSummaryGateway, type GatewaySummaryAiBinding, type GatewaySummaryEnv, type SummaryLane } from "@/lib/ai/gateway-summary";
import { completeJsonWithMetadata } from "@/lib/ai/client";
import { summarizeArticle } from "@/lib/ai/summarize";
import { SummarySchema } from "@/lib/ai/schema";

type Receipt = {
  lane: "G1" | "G2" | "G3" | "G4";
  country: string;
  sourceKey: string;
  articleId: string;
  sourceHash: string;
  officialUrl: string;
  decisionDate: string;
  sourceChars: number;
  baselineCorePoints: number;
  httpStatus: number;
  model: string;
  gatewayLogId: string;
  completionId: string;
  elapsedMs: number;
  promptTokens: number;
  completionTokens: number;
  jsonParsed: boolean;
  requiredShapeValid: boolean;
  corePoints: number;
  finishReason: string;
  byokAlias: string;
  wholesale: boolean;
  payloadCollected: boolean;
  privateAfter?: {
    status: string;
    publishable: boolean;
    reviewRequired: boolean;
    summaryStored: boolean;
    publicationRows: number;
    approvalReceipts: number;
  };
};

type Fixture = {
  gatewayId: string;
  route: string;
  routeVersion: string;
  callMode: string;
  byokOnly: boolean;
  payloadLoggingDisabled: boolean;
  receipts: Receipt[];
};

const fixture = JSON.parse(readFileSync(new URL("./fixtures/ai-gateway-p3-20261111.json", import.meta.url), "utf8")) as Fixture;
const models = new Set(["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
const sources = {
  G1: { sourceKey: "de-bverfg", jurisdiction: "Germany", institutionName: "Bundesverfassungsgericht", language: "de", title: "Beschluss vom 15. Oktober 2026", lane: "ingest" as const, flag: "WORLDCONS_SUMMARY_BACKEND_G1" as const },
  G2: { sourceKey: "es-tribunal-constitucional", jurisdiction: "Spain", institutionName: "Tribunal Constitucional", language: "es", title: "AUTO 48/2026", lane: "scheduled" as const, flag: "WORLDCONS_SUMMARY_BACKEND_G2" as const },
  G3: { sourceKey: "fr-conseil-constitutionnel", jurisdiction: "France", institutionName: "Conseil constitutionnel", language: "fr", title: "Décision n° 2026-1230/1231 QPC", lane: "admin" as const, flag: "WORLDCONS_SUMMARY_BACKEND_G3" as const },
  G4: { sourceKey: "us-scotus", jurisdiction: "United States", institutionName: "Supreme Court of the United States", language: "en", title: "Mullin v. Friends of the Ruidosa Church", lane: "us-private" as const, flag: "WORLDCONS_SUMMARY_BACKEND_G4" as const },
};

const validSummary = {
  koreanTitle: "헌법재판 사건의 주요 쟁점과 판결",
  originalTitle: "Constitutional court decision",
  summary: {
    coreSummary: ["공식 원문에 따른 헌법적 쟁점을 검토했습니다."],
    referencedProvisions: [],
    background: "헌법재판 절차가 제기되었습니다.",
    caseStructure: "당사자의 청구와 재판 절차를 검토했습니다.",
    implications: "헌법적 쟁점에 관한 판단입니다.",
    practicalNotes: "공식 법원 원문을 확인해야 합니다.",
  },
  entities: [],
  tags: ["헌법"],
  categories: ["판례"],
  riskFlags: [],
};

test("P3 audit dataset is exactly four distinct, grounded, real full-text Gateway probes", () => {
  assert.equal(fixture.gatewayId, "default");
  assert.equal(fixture.route, "dynamic/gemini-flash-fallback");
  assert.equal(fixture.callMode, "isolated-read-only-gateway-probe-not-deployed-worker-e2e");
  assert.equal(fixture.byokOnly, true);
  assert.equal(fixture.payloadLoggingDisabled, true);
  assert.match(fixture.routeVersion, /^[0-9a-f-]{36}$/);
  assert.deepEqual(fixture.receipts.map((r) => r.lane), ["G1", "G2", "G3", "G4"]);
  assert.equal(new Set(fixture.receipts.map((r) => r.articleId)).size, 4);
  assert.equal(new Set(fixture.receipts.map((r) => r.gatewayLogId)).size, 4);
  for (const receipt of fixture.receipts) {
    assert.equal(receipt.sourceKey, sources[receipt.lane].sourceKey);
    assert.match(receipt.sourceHash, /^[0-9a-f]{64}$/);
    assert.ok(receipt.officialUrl.startsWith("https://"));
    assert.match(receipt.decisionDate, /^2026-\d{2}-\d{2}$/);
    assert.ok(receipt.sourceChars > 5000, "must not be a synthetic one-line probe");
    assert.equal(receipt.httpStatus, 200);
    assert.ok(models.has(receipt.model));
    assert.ok(receipt.gatewayLogId.startsWith("01"));
    assert.ok(receipt.completionId);
    assert.ok(receipt.elapsedMs > 0);
    assert.ok(receipt.promptTokens > 0 && receipt.completionTokens > 0);
    assert.equal(receipt.jsonParsed, true);
    assert.equal(receipt.requiredShapeValid, true);
    assert.ok(receipt.corePoints > 0);
    assert.equal(receipt.finishReason, "stop");
    assert.equal(receipt.byokAlias, "default");
    assert.equal(receipt.wholesale, false);
    assert.equal(receipt.payloadCollected, false);
  }
  assert.deepEqual(fixture.receipts[3].privateAfter, {
    status: "metadata_only",
    publishable: false,
    reviewRequired: true,
    summaryStored: false,
    publicationRows: 0,
    approvalReceipts: 0,
  });
});

test("P3 all four isolated Worker summary lanes use the same dynamic route and preserve entire prompt provenance", async () => {
  for (const receipt of fixture.receipts) {
    const source = sources[receipt.lane];
    let calls = 0;
    const sourceText = `Official court decision source for ${source.title}. `.repeat(180);
    const ai: GatewaySummaryAiBinding = {
      async run(model, input, options) {
        calls++;
        assert.equal(model, fixture.route);
        assert.equal(options.gateway.id, fixture.gatewayId);
        assert.equal(options.gateway.skipCache, true);
        assert.equal(options.extraHeaders?.["cf-aig-collect-log-payload"], "false");
        const userPrompt = input.messages.find((m) => m.role === "user")?.content || "";
        assert.ok(userPrompt.includes(sourceText), "must not truncate staged full-text fixture");
        assert.ok(userPrompt.includes(receipt.officialUrl));
        assert.ok(userPrompt.includes(receipt.decisionDate));
        assert.ok(userPrompt.includes(source.title));
        assert.equal(JSON.stringify(input).includes("AIza"), false);
        return {
          id: "p3-mock-" + receipt.lane,
          model: receipt.model,
          choices: [{ message: { content: JSON.stringify({ ...validSummary, originalTitle: source.title }) } }],
        };
      },
    };
    const env: GatewaySummaryEnv = { AI: ai, [source.flag]: "cloudflare-ai-gateway" };
    const gateway = resolveSummaryGateway(env, source.lane as SummaryLane);
    assert.ok(gateway);
    const result = await summarizeArticle({
      sourceKey: source.sourceKey,
      jurisdiction: source.jurisdiction,
      institutionName: source.institutionName,
      contentType: "opinion",
      originalLanguage: source.language,
      originalUrl: receipt.officialUrl,
      canonicalUrl: receipt.officialUrl,
      originalTitle: source.title,
      originalPublishedAt: receipt.decisionDate,
      cleanedText: sourceText,
    }, { gateway, allowProviderFallback: false });
    assert.equal(SummarySchema.safeParse(result).success, true);
    assert.equal(result.aiMetadata?.model, receipt.model);
    assert.equal(result.aiMetadata?.provider, "cloudflare-ai-gateway");
    assert.equal(result.originalTitle, source.title);
    assert.equal(calls, 1);
  }
});

test("P3 Gateway model outage, timeout and invalid response fail closed with no hidden provider call", async () => {
  for (const status of [429, 504]) {
    let calls = 0;
    const sensitive = "AIza-cannot-leak-source-text";
    const ai: GatewaySummaryAiBinding = {
      async run() {
        calls++;
        throw { status, message: sensitive };
      },
    };
    await assert.rejects(
      completeJsonWithMetadata([{ role: "user", content: "test" }], {
        gateway: { ai, gatewayId: fixture.gatewayId, route: "gemini-flash-fallback" },
        allowProviderFallback: false,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, `summary_gateway.request_failed ${status}`);
        assert.equal(error.message.includes(sensitive), false);
        return true;
      },
    );
    assert.equal(calls, 1, "no automatic cross-vendor retry");
  }
  let calls = 0;
  const ai: GatewaySummaryAiBinding = {
    async run() {
      calls++;
      return { model: "gemini-3.1-flash-lite", choices: [{ message: { content: "not valid JSON" } }] };
    },
  };
  await assert.rejects(completeJsonWithMetadata([{ role: "user", content: "test" }], {
    gateway: { ai, gatewayId: "default", route: "gemini-flash-fallback" },
  }), /summary_gateway.invalid_json/);
  assert.equal(calls, 2, "invalid JSON gets exactly one same-route repair, not a provider fallback");
});

test("P3 Gateway output cannot rewrite original multi-line decision identity", async () => {
  const originalTitle = "Décision n° 2026-1230/1231 QPC du 23 octobre 2026\nAssociation des employeurs\nNon conformité totale";
  const ai: GatewaySummaryAiBinding = {
    async run() {
      return {
        model: "gemini-3.5-flash-lite",
        choices: [{ message: { content: JSON.stringify({ ...validSummary, originalTitle: "2026 QPC summary (shortened)" }) } }],
      };
    },
  };
  const summary = await summarizeArticle({
    sourceKey: "fr-conseil-constitutionnel",
    jurisdiction: "France",
    institutionName: "Conseil constitutionnel",
    contentType: "opinion",
    originalLanguage: "fr",
    originalTitle,
    originalPublishedAt: "2026-10-23",
    originalUrl: "https://www.conseil-constitutionnel.fr/decision/2026/20261230_1231QPC.htm",
    canonicalUrl: "https://www.conseil-constitutionnel.fr/decision/2026/20261230_1231QPC.htm",
    cleanedText: "Décision du Conseil constitutionnel ".repeat(90),
  }, { gateway: { ai, gatewayId: "default", route: "gemini-flash-fallback" } });
  assert.equal(summary.originalTitle, originalTitle);
  assert.equal(summary.aiMetadata?.provider, "cloudflare-ai-gateway");
});

test("P3 safety tests keep authenticated admin mutation and US private approval behind separate gates", () => {
  const adminReview = readFileSync(new URL("../app/api/admin/review/route.ts", import.meta.url), "utf8");
  const adminLlmTest = readFileSync(new URL("../app/api/admin/llm-settings/test/route.ts", import.meta.url), "utf8");
  const privateUs = readFileSync(new URL("../lib/cloudflare/summary/us-private-summary.ts", import.meta.url), "utf8");
  assert.match(adminReview, /adminMutationAuthFailureStatus\(request\)/);
  assert.match(adminLlmTest, /adminMutationAuthFailureStatus\(request\)/);
  assert.match(privateUs, /verifyOfficialPdfProvenance\(metadata\)/);
  assert.match(privateUs, /verifyR2Object\(input\.rawBucket, provenance\)/);
  assert.match(privateUs, /hasPublicationRow\(db, articleId\)/);
  assert.match(privateUs, /hasApprovalReceipt\(db, articleId\)/);
});

test("P4 legacy source-less ingest RPC calls retain G1 and G2 Gateway routing", () => {
  const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  const gatewayCode = readFileSync(new URL("../lib/ai/gateway-summary.ts", import.meta.url), "utf8");
  assert.match(worker, /runSummaryDrain\([\s\S]*?resolveSummaryGateway\(env, input\.source \?\? "scheduled"\)/u);
  assert.match(worker, /runSummaryArticle\([\s\S]*?resolveSummaryGateway\(env, input\.source \?\? "ingest"\)/u);
  assert.match(gatewayCode, /if \(!source\) return undefined;/u, "other unspecified lanes remain fail-closed");
  const ai: GatewaySummaryAiBinding = { async run() { throw new Error("not invoked"); } };
  const env: GatewaySummaryEnv = {
    AI: ai,
    WORLDCONS_SUMMARY_BACKEND_G1: "cloudflare-ai-gateway",
    WORLDCONS_SUMMARY_BACKEND_G2: "cloudflare-ai-gateway",
  };
  assert.equal(resolveSummaryGateway(env, "ingest")?.route, "gemini-flash-fallback");
  assert.equal(resolveSummaryGateway(env, "scheduled")?.route, "gemini-flash-fallback");
  assert.equal(resolveSummaryGateway(env, undefined), undefined);
});
