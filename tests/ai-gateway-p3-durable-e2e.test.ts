import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SqliteD1, articleId } from "./helpers/e2e-core-fixture";
import { setRuntimeD1Bindings, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { resolveSummaryGateway, type GatewaySummaryAiBinding, type SummaryLane } from "@/lib/ai/gateway-summary";
import { setRuntimeGatewayEnvironment } from "@/lib/ai/gateway-runtime";
import { runD1SummarizeArticle, runD1SummaryDrain } from "@/lib/cloudflare/summary/d1-summary-drain";
import { runD1PrivateUsSummary } from "@/lib/cloudflare/summary/us-private-summary";
import { runD1AdminReviewAction } from "@/lib/admin/d1-review";
import { runNativeAdminJobDrain } from "../workers/async-pipeline/src/admin-job-drain";
import { SummarySchema } from "@/lib/ai/schema";

// Unlike earlier P1/P2 tests, these run the *actual* summarizeArticle adapter
// through its Worker AI binding mock AND its real SQL claim/write code.
// The only substitute is the network AI response, not the summary function.
// All SQLite D1/R2 fixtures are in-memory and never touch production data.
const model = "gemini-3.5-flash-lite";
const sourceText = "Eine amtliche Entscheidung zur Verfassungsbeschwerde und zum Grundrechtsschutz. ".repeat(28);
const sourceUrl = "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2026/10/rk20261015_2bvr173526.html";
const summary = {
  koreanTitle: "헌법재판기관의 잠정처분",
  originalTitle: "LLM-altered official title",
  summary: {
    coreSummary: ["법원이 헌법소원에 관한 긴급 보호를 판단하였습니다."],
    referencedProvisions: [],
    background: "헌법소원이 제기되었습니다.",
    caseStructure: "신청인의 주장과 헌법적 요건을 검토했습니다.",
    implications: "기본권 보장과 절차를 검토합니다.",
    practicalNotes: "원문을 확인해야 합니다.",
  },
  entities: [],
  tags: ["헌법소원"],
  categories: ["판례"],
  riskFlags: [],
};

function aiBinding(output: unknown = summary) {
  let calls = 0;
  const ai: GatewaySummaryAiBinding = {
    async run(route, input, options) {
      calls++;
      assert.equal(route, "dynamic/gemini-flash-fallback");
      assert.equal(options.gateway.id, "default");
      assert.equal(options.extraHeaders?.["cf-aig-collect-log-payload"], "false");
      assert.ok(input.messages.some(m => m.role === "user"));
      return {
        model,
        choices: [{ message: { content: JSON.stringify(output) } }],
      };
    },
  };
  return { ai, get calls() { return calls; } };
}

function gateway(ai: GatewaySummaryAiBinding, lane: SummaryLane) {
  const env = {
    AI: ai,
    WORLDCONS_SUMMARY_BACKEND_G1: "cloudflare-ai-gateway",
    WORLDCONS_SUMMARY_BACKEND_G2: "cloudflare-ai-gateway",
    WORLDCONS_SUMMARY_BACKEND_G3: "cloudflare-ai-gateway",
    WORLDCONS_SUMMARY_BACKEND_G4: "cloudflare-ai-gateway",
  };
  return resolveSummaryGateway(env, lane)!;
}

function setupPublic(t: { after(fn: () => void): void }, sourceKey: string) {
  const core = new SqliteD1();
  const ingest = new SqliteD1("ingest");
  t.after(() => { core.close(); ingest.close(); setRuntimeD1Bindings({}); setRuntimeGatewayEnvironment(null); });
  core.db.prepare("UPDATE articles SET status='cleaned',translation_status='pending',summary_json=NULL,korean_title=NULL,summarized_at=NULL,lifecycle_processing_state='ready',source_key=?,jurisdiction=?,institution_name=?,original_language=?,original_title=?,original_url=?,canonical_url=?,cleaned_text=?,updated_at=? WHERE id=?")
    .run(sourceKey, "Germany", "Bundesverfassungsgericht", "de", "Amtlicher Beschluss 2 BvR 1735/26", sourceUrl, sourceUrl, sourceText, "2026-10-15T09:00:00Z", articleId);
  setRuntimeD1Bindings({worldcons_core: core as D1RuntimeDatabase, worldcons_ingest: ingest as D1RuntimeDatabase});
  return {core, ingest};
}

function assertPublicNotPublished(core: SqliteD1) {
  assert.equal(core.rows("article_publications_p3").length, 0);
  assert.equal(core.rows("article_cache_outbox_p3").length, 0);
  assert.equal(core.rows("e2e_approval_evidence_v1").length, 0);
}

test("P3 durable G1 uses real JSON adapter + SQLite CAS, records actual model, and replay does not call AI again", async t => {
  const {core} = setupPublic(t, "de-bverfg");
  const ai = aiBinding();
  const input = {articleId, source: "ingest" as const, apiKeys: [], gateway: gateway(ai.ai, "ingest"), createEmbedding: async () => null};
  const first = await runD1SummarizeArticle(input);
  assert.equal(first.result.status, "summarized");
  assert.equal(ai.calls, 1);
  const saved = core.db.prepare("SELECT original_title,summary_json,translation_provider,translation_model,status FROM articles WHERE id=?").get(articleId)!;
  assert.equal(saved.status, "summarized");
  assert.equal(saved.translation_provider, "cloudflare-ai-gateway");
  assert.equal(saved.translation_model, model);
  const parsed = SummarySchema.parse(JSON.parse(String(saved.summary_json)));
  assert.equal(parsed.originalTitle, saved.original_title, "official original title is immutable");
  assertPublicNotPublished(core);
  const second = await runD1SummarizeArticle(input);
  assert.ok(["summarized", "skipped"].includes(String(second.result.status)));
  assert.equal(ai.calls, 1, "a completed summary cannot trigger a second billable AI request");
});

test("P3 durable G2 scheduled drain writes one real Gateway result, stays unpublished, and skips repeated work", async t => {
  const {core} = setupPublic(t, "es-tribunal-constitucional");
  const ai = aiBinding();
  const input = {apiKeys: [], gateway: gateway(ai.ai, "scheduled"), sourceKey: "es-tribunal-constitucional", limit: 1, maxPasses: 1, createEmbedding: async () => null};
  const first = await runD1SummaryDrain(input);
  assert.equal(first.summarizedCount, 1, JSON.stringify(first));
  assert.equal(ai.calls, 1);
  assert.equal(core.db.prepare("SELECT translation_model FROM articles WHERE id=?").get(articleId)?.translation_model, model);
  assertPublicNotPublished(core);
  const second = await runD1SummaryDrain(input);
  assert.equal(second.summarizedCount, 0);
  assert.equal(ai.calls, 1);
});

test("P3 durable G1 Gateway 429 fails closed, redacts provider error, writes no summary or publication", async t => {
  const {core} = setupPublic(t, "de-bverfg");
  let calls=0;
  const ai: GatewaySummaryAiBinding = {
    async run() {
      calls++;
      throw {status:429,message:"AIza-secret-should-never-enter-D1"};
    },
  };
  await assert.rejects(runD1SummarizeArticle({
    articleId, source:"ingest", apiKeys:[], gateway:gateway(ai,"ingest"), createEmbedding:async()=>null,
  }), /summary_gateway.request_failed 429/);
  assert.equal(calls,1,"no additional provider call on HTTP 429");
  const row=core.db.prepare("SELECT status,summary_json,translation_error_code,error_context FROM articles WHERE id=?").get(articleId)!;
  assert.equal(row.summary_json,null);
  assert.equal(JSON.stringify(row).includes("AIza-secret"),false);
  assert.ok(["failed_summary","cleaned"].includes(String(row.status)));
  assertPublicNotPublished(core);
});

test("P3 durable G3 queues, claims and completes an actual admin retry job via Gateway lane", async t => {
  const {core, ingest} = setupPublic(t, "fr-conseil-constitutionnel");
  const ops = new SqliteD1();
  t.after(() => ops.close());
  ops.db.exec(readFileSync(new URL("../d1/worldcons_ops/0001_init.sql", import.meta.url), "utf8"));
  setRuntimeD1Bindings({
    worldcons_core: core as D1RuntimeDatabase,
    worldcons_ingest: ingest as D1RuntimeDatabase,
    worldcons_ops: ops as D1RuntimeDatabase,
  });
  const ai = aiBinding();
  const config = gateway(ai.ai, "admin");
  setRuntimeGatewayEnvironment({AI: ai.ai, WORLDCONS_SUMMARY_BACKEND_G3: "cloudflare-ai-gateway"});
  const body = {
    action: "retry-summary" as const,
    articleId, slug: undefined, provider: undefined, model: undefined,
    note: undefined, expectedApprovalSnapshotHash: undefined,
  };
  const queued = await runD1AdminReviewAction(body, "human:reviewer");
  assert.equal(queued.status, "queued");
  const jobs = ops.rows("admin_jobs");
  assert.equal(jobs.length, 1);
  const opts = JSON.parse(String(jobs[0].options));
  assert.equal(opts.provider, "cloudflare-ai-gateway");
  assert.equal(opts.model, null);
  const service = {
    async runSummaryArticle(input: {articleId?: string; model?: string; source?: "admin"; requestedProvider?: "gemini"|"cloudflare-ai-gateway"}) {
      assert.equal(input.source, "admin");
      assert.equal(input.requestedProvider, "cloudflare-ai-gateway");
      assert.equal(input.model, undefined);
      return runD1SummarizeArticle({ articleId: input.articleId, apiKeys: [], gateway: config, createEmbedding: async () => null });
    },
    async runSummaryDrain() { throw new Error("must be a targeted admin retry"); },
    async runRefreshTagCounts() { throw new Error("unexpected refresh"); },
  };
  const result = await runNativeAdminJobDrain({
    env: {WORLDCONS_APP_SERVICE: service} as never,
    idempotencyKey: "test-g3-exact-once",
    maxJobs: 1,
    browserNavigate: async () => { throw new Error("admin summary must not navigate"); },
  });
  assert.equal(result.succeeded, 1, JSON.stringify(result));
  assert.equal(ai.calls, 1);
  assert.equal(core.db.prepare("SELECT translation_model FROM articles WHERE id=?").get(articleId)?.translation_model, model);
  assert.equal(ops.rows("admin_jobs")[0].status, "succeeded");
  assertPublicNotPublished(core);
  const duplicate = await runD1AdminReviewAction(body, "human:reviewer");
  assert.equal(duplicate.status, "queued");
  assert.equal(ops.rows("admin_jobs").length, 1, "duplicate admin submission must converge to same durable job");
});

test("P3 G3 rejects model override on generic retry-summary BEFORE queuing", async t => {
  const {core} = setupPublic(t, "fr-conseil-constitutionnel");
  const ai = aiBinding();
  setRuntimeGatewayEnvironment({AI: ai.ai, WORLDCONS_SUMMARY_BACKEND_G3: "cloudflare-ai-gateway"});
  const result = await runD1AdminReviewAction({
    action: "retry-summary", articleId, slug: undefined,
    provider: "gemini", model: "gemini-3.1-flash-lite",
    note: undefined, expectedApprovalSnapshotHash: undefined,
  }, "human:reviewer");
  assert.equal(result.status, "unsupported_provider");
  assert.equal(ai.calls, 0);
  assert.equal(core.db.prepare("SELECT status FROM articles WHERE id=?").get(articleId)?.status, "cleaned");
});

test("P3 durable G4 uses real official-PDF R2 hash gate and persists private summary without publication", async t => {
  const core = new SqliteD1();
  t.after(() => {core.close();setRuntimeD1Bindings({});});
  for (const file of ["0008_e2e_core_writer_guards.sql", "0009_e2e_source_ownership.sql"]) {
    core.db.exec(readFileSync(new URL(`../d1/worldcons_core/${file}`, import.meta.url), "utf8"));
  }
  setRuntimeD1Bindings({worldcons_core: core as D1RuntimeDatabase});
  const usId = "d8dc4ebc-7193-4a2d-8bcf-21e9cbbe4127";
  const url = "https://www.supremecourt.gov/opinions/26pdf/26a560_onkq.pdf";
  const bytes = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const metadata = {
    officialPdf: {url, r2Key: `artifacts/scotus_pdf/${sha}.pdf`, sha256: sha, docketVerified: true},
    collection: {publishable: false, sourceTextAvailable: true, sourceUrlVerified: true, robotsDisallowed: false, strategy: "official-pdf"},
    review: {required: true, reason: "scotus_pdf_human_review_required"},
  };
  core.db.prepare("INSERT INTO articles (id,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,discovered_at,fetched_at,status,slug,cleaned_text,summary_json,source_metadata,created_at,updated_at,lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state,lifecycle_attention_state,translation_status,review_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(usId,"us-scotus","United States","Supreme Court of the United States","opinion",url,url,"en","Official SCOTUS order","2026-10-14T21:00:00Z","2026-10-14T21:00:25Z","metadata_only","us-p3-fixture","Official Supreme Court opinion text ".repeat(80),null,JSON.stringify(metadata),"2026-10-14T21:00:00Z","2026-10-14T21:00:25Z","metadata_only","not_ready","needs_review","active","not_required","needs_triage");
  const bucket = { async get() {return { arrayBuffer: async () => bytes.buffer as ArrayBuffer };} };
  const ai = aiBinding();
  const input = {articleId:usId,apiKeys:[],gateway:gateway(ai.ai,"us-private"),rawBucket:bucket};
  const first = await runD1PrivateUsSummary(input);
  assert.equal(first.status,"summarized",JSON.stringify(first));
  assert.equal(first.provider,"cloudflare-ai-gateway");
  assert.equal(ai.calls,1);
  const row=core.db.prepare("SELECT status,source_metadata,summary_json,translation_model,review_state FROM articles WHERE id=?").get(usId)!;
  assert.equal(row.status,"summarized");
  assert.equal(row.translation_model,model);
  assert.equal(SummarySchema.safeParse(JSON.parse(String(row.summary_json))).success,true);
  const storedMetadata=JSON.parse(String(row.source_metadata));
  assert.equal(storedMetadata.collection.publishable,false);
  assert.equal(storedMetadata.review.required,true);
  assert.equal(row.review_state,"needs_review");
  assertPublicNotPublished(core);
  assert.equal(core.rows("case_catalog_publications_v1").length,0);
  assert.equal((await runD1PrivateUsSummary(input)).status,"already_summarized");
  assert.equal(ai.calls,1);
});
