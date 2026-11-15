import { setRuntimeD1Bindings, type D1RuntimeDatabase } from "../../lib/cloudflare/d1/runtime-binding";
import { setRuntimeGatewayEnvironment } from "../../lib/ai/gateway-runtime";
import { resolveSummaryGateway, type GatewaySummaryAiBinding } from "../../lib/ai/gateway-summary";
import { setRuntimePlatform } from "../../lib/runtime/platform";
import { setRuntimeJsonStateStore, createMemoryRuntimeJsonStateStore } from "../../lib/runtime/persistent-state";
import { runD1SummarizeArticle, runD1SummaryDrain } from "../../lib/cloudflare/summary/d1-summary-drain";
import { runD1PrivateUsSummary } from "../../lib/cloudflare/summary/us-private-summary";
import { runD1AdminReviewAction } from "../../lib/admin/d1-review";
import { runNativeAdminJobDrain } from "../../workers/async-pipeline/src/admin-job-drain";
import { SummarySchema } from "../../lib/ai/schema";
import { auditLegalEvidence } from "../../lib/ai/legal-evidence-audit";

interface D1Prepared {
  bind(...values: unknown[]): D1Prepared;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
  run(): Promise<{ success: boolean; meta?: { changes: number } }>;
}
interface D1Database {
  prepare(sql: string): D1Prepared;
}
interface RawObject {
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface R2Bucket {
  put(key: string, data: Uint8Array): Promise<unknown>;
  get(key: string): Promise<RawObject | null>;
  delete(key: string): Promise<void>;
}
interface Env {
  AI: GatewaySummaryAiBinding;
  WORLDCONS_CORE: D1Database;
  WORLDCONS_INGEST: D1Database;
  WORLDCONS_OPS: D1Database;
  WORLDCONS_RAW: R2Bucket;
  P3_REMOTE_AUTH: string;
}
type Lane = "g1" | "g2" | "g3" | "g4" | "g1-429";

const records = {
  g1: { id: "e760950f-8a54-4d1f-b2ca-240b9219c1e1", source: "de-bverfg", country: "Germany", court: "Bundesverfassungsgericht", language: "de", title: "Beschluss 2 BvR 1735/26" },
  g2: { id: "e760950f-8a54-4d1f-b2ca-240b9219c1e2", source: "es-tribunal-constitucional", country: "Spain", court: "Tribunal Constitucional", language: "es", title: "AUTO 48/2026" },
  g3: { id: "e760950f-8a54-4d1f-b2ca-240b9219c1e3", source: "fr-conseil-constitutionnel", country: "France", court: "Conseil constitutionnel", language: "fr", title: "Décision n° 2026-1230 QPC" },
  g4: { id: "e760950f-8a54-4d1f-b2ca-240b9219c1e4", source: "us-scotus", country: "United States", court: "Supreme Court of the United States", language: "en", title: "Mullin v. Friends of the Ruidosa Church" },
  "g1-429": { id: "e760950f-8a54-4d1f-b2ca-240b9219c1e5", source: "de-bverfg", country: "Germany", court: "Bundesverfassungsgericht", language: "de", title: "Beschluss 2 BvR 1735/26" },
} as const;
const raw = {
  g1: ("Bundesverfassungsgericht. Beschluss zur Verfassungsbeschwerde. Das Gericht prüft den Antrag auf einstweiligen Rechtsschutz nach § 32 BVerfGG. Es entscheidet vorläufig unter Berücksichtigung des Grundgesetzes. ").repeat(11),
  g2: ("Tribunal Constitucional. AUTO 48/2026. La Sala examina la solicitud y los motivos de inadmisión en el recurso de amparo. Se examinan las garantías constitucionales y el trámite procesal. ").repeat(12),
  g3: ("Conseil constitutionnel. Décision n° 2026-1230 QPC. Le Conseil examine une question prioritaire de constitutionnalité concernant les garanties offertes par la loi. La décision est fondée sur la Constitution. ").repeat(12),
  g4: ("Supreme Court of the United States. Mullin v. Friends of the Ruidosa Church. The Court considers an application for a stay and the jurisdictional limitations under IIRIRA Section 102. Respondents argued that the challenged waivers exceeded statutory authority. ").repeat(10),
};
const pdfBytes = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF");
let aiCalls = 0;
let storedR2Key = "";

function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^summary_(?:gateway|d1)\.[a-z0-9_. -]+$/i.test(message) ? message.slice(0, 90) : "p3_remote_operation_failed";
}

function gateway(env: Env, lane: "ingest" | "scheduled" | "admin" | "us-private", failure = false) {
  const wrapped: GatewaySummaryAiBinding = {
    run: (model, input, options) => {
      aiCalls++;
      if (failure) return Promise.reject({ status: 429, message: "AIza-STAGING-MUST-NOT-LEAK" });
      return env.AI.run(model, input, options);
    },
  };
  return resolveSummaryGateway({
    AI: wrapped,
    WORLDCONS_SUMMARY_BACKEND: "cloudflare-ai-gateway",
    WORLDCONS_AI_GATEWAY_ID: "default",
    WORLDCONS_AI_GATEWAY_ROUTE: "gemini-flash-fallback",
  }, lane)!;
}

function install(env: Env) {
  setRuntimePlatform("cloudflare-worker");
  setRuntimeJsonStateStore(createMemoryRuntimeJsonStateStore());
  setRuntimeD1Bindings({
    worldcons_core: env.WORLDCONS_CORE as D1RuntimeDatabase,
    worldcons_ingest: env.WORLDCONS_INGEST as D1RuntimeDatabase,
    worldcons_ops: env.WORLDCONS_OPS as D1RuntimeDatabase,
  });
  setRuntimeGatewayEnvironment({ AI: env.AI, WORLDCONS_SUMMARY_BACKEND_G3: "cloudflare-ai-gateway" });
}

type OfficialG1 = { text: string; title: string; url: string };

async function seed(env: Env, officialG1?: OfficialG1) {
  if (officialG1 && (
    typeof officialG1.text !== "string" || officialG1.text.length < 1000 || officialG1.text.length > 20000
    || !officialG1.text.includes("Die Abschiebung der Beschwerdeführerin")
    || !officialG1.text.includes("2 BvR 1735/26")
    || typeof officialG1.title !== "string" || !officialG1.title.trim() || officialG1.title.length > 260
    || officialG1.url !== "https://www.bverfg.de/e/rk20261015_2bvr173526"
  )) throw Error("invalid_official_source_fixture");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", pdfBytes));
  const sha = [...hash].map(n => n.toString(16).padStart(2, "0")).join("");
  storedR2Key = "artifacts/scotus_pdf/" + sha + ".pdf";
  await env.WORLDCONS_RAW.put(storedR2Key, pdfBytes);
  for (const lane of Object.keys(records) as Lane[]) {
    const item = records[lane];
    const isPrivate = lane === "g4";
    const meta = isPrivate ? {
      officialPdf: { url: "https://www.supremecourt.gov/opinions/26pdf/26a560_onkq.pdf", sha256: sha, r2Key: storedR2Key, docketVerified: true },
      collection: { publishable: false, sourceTextAvailable: true, sourceUrlVerified: true, strategy: "official-pdf" },
      review: { required: true, reason: "private human review" },
    } : {
      collection: { publishable: true, sourceTextAvailable: true, sourceUrlVerified: true, strategy: "fetch" },
    };
    const url = lane === "g1" && officialG1 ? officialG1.url
      : isPrivate ? "https://www.supremecourt.gov/opinions/26pdf/26a560_onkq.pdf"
      : lane === "g2" ? "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/fixture48"
      : lane === "g3" ? "https://www.conseil-constitutionnel.fr/decision/2026/20261230QPC.htm"
      : lane === "g1-429" ? "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/10/fixture-failure.htm"
      : "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/10/fixture.htm";
    const created = new Date().toISOString();
    await env.WORLDCONS_CORE.prepare(
      "INSERT INTO articles(id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,original_published_at,discovered_at,fetched_at,status,slug,cleaned_text,summary_json,source_metadata,created_at,updated_at,lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state,lifecycle_attention_state,translation_status,review_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(item.id,item.source,item.country,item.court,"opinion",url,url,item.language,lane === "g1" && officialG1 ? officialG1.title : item.title,"2026-10-15",created,created,isPrivate?"metadata_only":"cleaned","remote-p3-"+lane,
      lane === "g1" && officialG1 ? officialG1.text : isPrivate?raw.g4:raw[lane === "g1-429" ? "g1" : lane],null,JSON.stringify(meta),created,created,
      isPrivate?"metadata_only":"source_text_ready",isPrivate?"not_ready":"ready",isPrivate?"needs_review":"unreviewed",
      isPrivate?"active":"clear",isPrivate?"not_required":"pending",isPrivate?"needs_triage":null
    ).run();
  }
  let officialHash: string | null = null;
  if (officialG1) {
    const bytes = new TextEncoder().encode(officialG1.text);
    officialHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map(n => n.toString(16).padStart(2, "0")).join("");
  }
  return { seeded: 5, remoteD1: true, realR2: true,
    officialG1: Boolean(officialG1), officialSourceSha256: officialHash,
    officialSourceChars: officialG1?.text.length ?? null };
}

async function facts(env: Env, lane: Lane) {
  const row = (await env.WORLDCONS_CORE.prepare(
    "SELECT status, original_title, cleaned_text, summary_json, source_metadata, review_state, translation_provider, translation_model, error_context FROM articles WHERE id=?"
  ).bind(records[lane].id).all<Record<string, unknown>>()).results[0];
  const counts = await Promise.all([
    env.WORLDCONS_CORE.prepare("SELECT COUNT(*) n FROM article_publications_p3").all<{n:number}>(),
    env.WORLDCONS_CORE.prepare("SELECT COUNT(*) n FROM article_cache_outbox_p3").all<{n:number}>(),
    env.WORLDCONS_CORE.prepare("SELECT COUNT(*) n FROM e2e_approval_evidence_v1").all<{n:number}>(),
  ]);
  const published = counts.map(c => c.results[0]?.n ?? -1);
  let titleRetained = false, schemaValid = false, legalAudit: unknown = null;
  if (typeof row?.summary_json === "string") {
    try {
      const summary = JSON.parse(row.summary_json);
      schemaValid = SummarySchema.safeParse(summary).success;
      titleRetained = summary.originalTitle === row.original_title;
      const sourceText = typeof row.cleaned_text === "string" ? row.cleaned_text : "";
      legalAudit = auditLegalEvidence({sourceKey: records[lane].source, originalTitle: String(row.original_title), cleanedText: sourceText}, summary);
    } catch { /* never reveal summary payload */ }
  }
  const metadata = typeof row?.source_metadata === "string" ? JSON.parse(row.source_metadata) : {};
  return {
    status: row?.status,
    summaryStored: typeof row?.summary_json === "string",
    schemaValid,
    titleRetained,
    provider: row?.translation_provider,
    model: row?.translation_model,
    reviewState: row?.review_state,
    publishable: metadata.collection?.publishable,
    reviewRequired: metadata.review?.required,
    publishedRows: published[0], cacheOutboxRows: published[1], humanApprovalRows: published[2],
    errorLeaked: JSON.stringify(row?.error_context ?? "").includes("AIza"),
    legalAudit,
  };
}

async function run(env: Env, lane: Lane) {
  aiCalls = 0;
  let operation: unknown;
  let failure: string | null = null;
  try {
    if (lane === "g1" || lane === "g1-429") {
      operation = await runD1SummarizeArticle({
        articleId: records[lane].id, source: "ingest", apiKeys: [],
        gateway: gateway(env, "ingest", lane === "g1-429"),
        createEmbedding: async () => null,
      });
    } else if (lane === "g2") {
      operation = await runD1SummaryDrain({
        sourceKey: records.g2.source, limit: 1, maxPasses: 1, apiKeys: [],
        gateway: gateway(env, "scheduled"), createEmbedding: async () => null,
      });
    } else if (lane === "g3") {
      const queued = await runD1AdminReviewAction({action:"retry-summary",articleId: records.g3.id,slug:undefined,provider:undefined,model:undefined,note:undefined,expectedApprovalSnapshotHash:undefined});
      const adminGateway = gateway(env,"admin");
      const appService = {
        async runSummaryArticle(input: {articleId?:string; model?:string; requestedProvider?:string}) {
          if (input.model || input.requestedProvider !== "cloudflare-ai-gateway") throw Error("unexpected_admin_routing");
          return runD1SummarizeArticle({
            articleId: input.articleId, source:"admin",apiKeys:[],gateway:adminGateway,createEmbedding:async()=>null,
          });
        },
        async runSummaryDrain() { throw Error("unexpected_admin_bulk"); },
        async runRefreshTagCounts() { throw Error("unexpected_admin_tag"); },
      };
      const drained = await runNativeAdminJobDrain({
        env: {WORLDCONS_APP_SERVICE:appService} as never, idempotencyKey:"p3-remote-admin",
        maxJobs:1, browserNavigate:async()=>{throw Error("browser_forbidden");},
      });
      operation={queueStatus:queued.status,claimed:drained.claimed,succeeded:drained.succeeded,failed:drained.failed};
    } else {
      operation=await runD1PrivateUsSummary({
        articleId:records.g4.id,apiKeys:[],
        gateway:gateway(env,"us-private"),rawBucket:env.WORLDCONS_RAW,
      });
    }
  } catch (error) { failure = reportError(error); }
  const state = await facts(env,lane);
  const summaryResult = operation && typeof operation === "object" ? operation as Record<string,unknown> : {};
  const inner = summaryResult.result && typeof summaryResult.result === "object" ? summaryResult.result as Record<string,unknown> : {};
  return {
    lane, actualRemoteD1:true, actualRemoteR2:lane==="g4",
    aiRequests:aiCalls,failure,
    outcome:typeof summaryResult.status==="string" ? summaryResult.status : typeof inner.status==="string"?inner.status:null,
    summarizedCount: typeof summaryResult.summarizedCount === "number" ? summaryResult.summarizedCount : null,
    admin:lane==="g3"?operation:null,
    ...state,
  };
}

export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    if (request.method!=="POST") {
      return new Response("Not found",{status:404});
    }
    if (!env.P3_REMOTE_AUTH) return Response.json({ok:false,error:"test_token_binding_missing"},{status:503});
    if (request.headers.get("x-p3-remote-auth")!==env.P3_REMOTE_AUTH) {
      return Response.json({ok:false,error:"test_token_mismatch"},{status:403});
    }
    install(env);
    try {
      if (path==="/seed") {
        const body = await request.json() as { officialG1?: OfficialG1 };
        return Response.json({ok:true,...await seed(env,body?.officialG1)});
      }
      if (path==="/cleanup-r2") {
        const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",pdfBytes));
        const key="artifacts/scotus_pdf/"+[...hash].map(n=>n.toString(16).padStart(2,"0")).join("")+".pdf";
        await env.WORLDCONS_RAW.delete(key);
        return Response.json({ok:true,objectRemoved:true});
      }
      const match=path.match(/^\/(g1|g2|g3|g4|g1-429)$/);
      if (match) return Response.json({ok:true,...await run(env,match[1] as Lane)});
      return Response.json({ok:false,error:"unknown_route"},{status:404});
    } catch(error) {
      return Response.json({ok:false,error:reportError(error)},{status:500});
    }
  },
};
