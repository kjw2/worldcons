import { resolveSummaryGateway, type GatewaySummaryAiBinding, type SummaryLane } from "../../lib/ai/gateway-summary";
import { summarizeArticle } from "../../lib/ai/summarize";
import { SummarySchema } from "../../lib/ai/schema";
import { auditLegalEvidence } from "../../lib/ai/legal-evidence-audit";

type P3Env = {
  AI: GatewaySummaryAiBinding;
  P3_LOCAL_TEST_TOKEN?: string;
  WORLDCONS_AI_GATEWAY_ID?: string;
  WORLDCONS_AI_GATEWAY_ROUTE?: string;
};

type Probe = {
  lane: SummaryLane;
  sourceKey: string;
  jurisdiction: string;
  institutionName: string;
  originalLanguage: string;
  originalTitle: string;
  originalPublishedAt: string;
  originalUrl: string;
  cleanedText: string;
};

const lanes = new Set<SummaryLane>(["ingest", "scheduled", "admin", "us-private"]);

/** Isolated staging probe: never bind D1/R2, approval, publication, Search or schedules.
 * This exercises the real Worker runtime, real AI binding, real summary prompt,
 * production Zod schema and per-lane backend selector without persistent writes.
 * Its local-dev config is separate from production Wrangler config.
 */
export default {
  async fetch(request: Request, env: P3Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/p3") {
      return new Response("Not found", { status: 404 });
    }
    if (!env.P3_LOCAL_TEST_TOKEN || request.headers.get("x-p3-local-token") !== env.P3_LOCAL_TEST_TOKEN) {
      return new Response("Not authorized", { status: 403 });
    }
    if (url.searchParams.get("diagnostic") === "1") {
      try {
        const r = await env.AI.run("dynamic/gemini-flash-fallback", {
          messages: [{ role: "user", content: "Return JSON: {\"ok\":true}" }],
          max_tokens: 256,
        }, {
          gateway: { id: "default", skipCache: true },
          extraHeaders: { "cf-aig-collect-log-payload": "false" },
        });
        return Response.json({ ok: Boolean(r), routeReached: true });
      } catch (error) {
        const obj = error && typeof error === "object" ? error as Record<string, unknown> : {};
        const message = typeof obj.message === "string" ? obj.message : "";
        return Response.json({
          ok: false,
          errorName: typeof obj.name === "string" ? obj.name : null,
          status: typeof obj.status === "number" ? obj.status : null,
          code: typeof obj.code === "number" || typeof obj.code === "string" ? obj.code : null,
          keys: Object.keys(obj).filter(k => !/authorization|token|secret|body|payload/i.test(k)).slice(0, 12),
          messageCategory: /unauthoriz|401|403|forbidden|authenti/i.test(message) ? "authentication"
            : /invalid|400|bad request|unsupported/i.test(message) ? "bad_request"
              : /model|route|not found|404/i.test(message) ? "routing" : "other",
        });
      }
    }
    let input: Probe;
    try { input = await request.json() as Probe; }
    catch { return Response.json({ error: "invalid_json_request" }, { status: 400 }); }
    if (!input || !lanes.has(input.lane)
      || typeof input.cleanedText !== "string" || input.cleanedText.length < 200 || input.cleanedText.length > 40000
      || typeof input.originalUrl !== "string" || !input.originalUrl.startsWith("https://")
      || typeof input.originalTitle !== "string" || !input.originalTitle
      || typeof input.originalPublishedAt !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(input.originalPublishedAt)) {
      return Response.json({ error: "invalid_fixture" }, { status: 400 });
    }
    const start = Date.now();
    const gateway = resolveSummaryGateway({
      AI: env.AI,
      WORLDCONS_SUMMARY_BACKEND: "cloudflare-ai-gateway",
      WORLDCONS_AI_GATEWAY_ID: env.WORLDCONS_AI_GATEWAY_ID,
      WORLDCONS_AI_GATEWAY_ROUTE: env.WORLDCONS_AI_GATEWAY_ROUTE,
    }, input.lane);
    try {
      const result = await summarizeArticle({
        sourceKey: input.sourceKey,
        jurisdiction: input.jurisdiction,
        institutionName: input.institutionName,
        contentType: "opinion",
        originalLanguage: input.originalLanguage,
        originalTitle: input.originalTitle,
        originalPublishedAt: input.originalPublishedAt,
        originalUrl: input.originalUrl,
        canonicalUrl: input.originalUrl,
        cleanedText: input.cleanedText,
      }, { gateway, allowProviderFallback: false });
      const parsed = SummarySchema.safeParse(result);
      const legalAudit = auditLegalEvidence({
        sourceKey: input.sourceKey,
        originalTitle: input.originalTitle,
        cleanedText: input.cleanedText,
      }, result);
      return Response.json({
        ok: parsed.success,
        lane: input.lane,
        provider: result.aiMetadata?.provider,
        model: result.aiMetadata?.model,
        gateway: "default/dynamic/gemini-flash-fallback",
        elapsedMs: Date.now() - start,
        titleChars: result.koreanTitle.length,
        corePoints: result.summary.coreSummary.length,
        referencedProvisions: result.summary.referencedProvisions.length,
        schemaValid: parsed.success,
        legalQualityAudit: legalAudit,
        originalTitlePreserved: result.originalTitle === input.originalTitle,
        // Ephemeral authenticated review only. Do not persist the output.
        review: {
          koreanTitle: result.koreanTitle.slice(0, 180),
          core: result.summary.coreSummary.slice(0, 4).map(s => s.slice(0, 420)),
          provisions: result.summary.referencedProvisions.slice(0, 8).map(p => ({
            law: p.lawName.slice(0, 100),
            article: p.article.slice(0, 90),
          })),
        },
      }, { status: parsed.success ? 200 : 422 });
    } catch (error) {
      return Response.json({
        ok: false,
        lane: input.lane,
        elapsedMs: Date.now() - start,
        error: error instanceof Error && /^summary_gateway\./.test(error.message) ? error.message : "summary_processing_failed",
      }, { status: 502 });
    }
  },
};
