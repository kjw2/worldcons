import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { transitionArticlePublicationInD1 } from "@/lib/cloudflare/core-write/authority";
import { consumeSearchRepair } from "@/lib/cloudflare/e2e/search-repair-consumer";
import { assertPublicSearchFreshness } from "@/lib/cloudflare/e2e/public-freshness";
import { applySearchProjectionPlan } from "@/lib/cloudflare/search-projection/d1-sync";
import { planSearchProjectionFullRebuild } from "@/lib/cloudflare/search-projection/plan";
import { SqliteD1, articleId, input } from "./helpers/e2e-core-fixture";

const require=createRequire(import.meta.url);
const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve("wrangler/package.json"))("miniflare");

test("M3 local workerd: separated real D1 APIs execute guard/FTS transaction, receipt and withdrawal",async(t)=>{
  const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,
    script:'export default { fetch() { return new Response("fixture") } }',compatibilityDate:"2026-09-20",
    d1Databases:{WORLDCONS_CORE:"m3-isolated-core",WORLDCONS_SEARCH:"m3-isolated-search"},cf:false,
    unsafeRegisterWorker:false}));
  t.after(async()=>{await runtime.dispose();});
  const core:D1RuntimeDatabase=await runtime.getD1Database("WORLDCONS_CORE"),search:D1RuntimeDatabase=await runtime.getD1Database("WORLDCONS_SEARCH");
  const seed=new SqliteD1(),searchSeed=new SqliteD1("search");t.after(()=>{seed.close();searchSeed.close();});
  for (const [db,source] of [[core,seed],[search,searchSeed]] as const) {
    // Native fixtures executed the authored migrations. Reuse their exact DDL
    // as complete statements, including trigger bodies with internal semicolons.
    const definitions=source.db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
    for (const row of definitions) {
      if (String(row.name).startsWith("search_fts_")) continue; // virtual-table shadow storage is created by FTS5
      await db.prepare(String(row.sql)).all();
    }
  }
  const article=seed.rows("articles")[0],columns=Object.keys(article);
  await core.prepare(`INSERT INTO articles (${columns.join(",")}) VALUES (${columns.map(()=>"?").join(",")})`).bind(...Object.values(article)).all();
  const published=await transitionArticlePublicationInD1(core,input(seed,"workerd-m3"));assert.ok(published.ok,JSON.stringify(published));
  const body={schemaVersion:1,type:"e2e-search-repair",outboxId:published.data.generation!.searchRepairOutboxId};
  assert.equal((await consumeSearchRepair(core,search,body)).status,"awaiting_verification");
  await assertPublicSearchFreshness(core,search,[articleId]);
  await assert.rejects(applySearchProjectionPlan(search,planSearchProjectionFullRebuild([],[])),/e2e_search_generation_match/);
  await assert.rejects(search.prepare("DELETE FROM search_documents").all(),/e2e_search_unguarded_writer/);
  assert.equal((await search.prepare("SELECT COUNT(*) AS count FROM search_fts").all()).results![0].count,1);
  const withdrawn=await transitionArticlePublicationInD1(core,{...input(seed,"workerd-withdraw"),captureLegacy:false,
    versionId:published.data.versionId,targetState:"withdrawn",expectedVersionRevision:published.data.versionRevision,
    expectedPublicationRevision:published.data.publicationRevision});assert.ok(withdrawn.ok,JSON.stringify(withdrawn));
  await assert.rejects(assertPublicSearchFreshness(core,search,[articleId]),/public_projection_pending/);
  assert.equal((await consumeSearchRepair(core,search,{...body,outboxId:withdrawn.data.generation!.searchRepairOutboxId})).status,"awaiting_verification");
  assert.equal((await search.prepare("SELECT tombstone FROM e2e_search_generation_guards_v1").all()).results![0].tombstone,1);
  assert.equal((await search.prepare("SELECT COUNT(*) AS count FROM search_fts").all()).results![0].count,0);
  assert.equal((await core.prepare("SELECT COUNT(*) AS count FROM e2e_search_apply_receipts_v1").all()).results![0].count,2);
  assert.equal((await core.prepare("SELECT COUNT(*) AS count FROM e2e_generation_progress_v1 WHERE state='completed_verified'").all()).results![0].count,0);
});
