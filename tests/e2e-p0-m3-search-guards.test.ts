import assert from "node:assert/strict";
import test from "node:test";
import { consumeSearchRepair } from "@/lib/cloudflare/e2e/search-repair-consumer";
import { applyGuardedSearchProjection, searchIdentity } from "@/lib/cloudflare/e2e/search-generation-guard";
import { assertPublicSearchFreshness, overlayPublicGenerationRows } from "@/lib/cloudflare/e2e/public-freshness";
import { currentGenerations } from "@/lib/cloudflare/e2e/generation-state";
import { applySearchProjectionPlan, runNativeSearchProjectionSync, syncSearchProjectionForArticle,
  readEligibleSourceForArticle, readTagsForArticleIds, buildSearchProjectionInputFromEligibleRows } from "@/lib/cloudflare/search-projection/d1-sync";
import { buildSearchProjection } from "@/lib/cloudflare/search-projection/build";
import { planSearchProjectionFullRebuild, planSearchProjectionIncrementalSync } from "@/lib/cloudflare/search-projection/plan";
import { consumeE2ESearchRepairBatch } from "../workers/async-pipeline/src/e2e-search-repair-queue";
import { handleWorldconsSearchRequest } from "@/lib/integrations/cclrag2/provider-handler";
import { createD1ArticleReadRepository } from "@/lib/article-reads/d1-repository";
import { SqliteD1, articleId, approval, publish } from "./helpers/e2e-core-fixture";
import { setRuntimeD1Bindings, clearRuntimeD1Bindings } from "@/lib/cloudflare/d1/runtime-binding";
import { freshnessAwarePublicCache } from "@/lib/public-freshness-cache";
import { readFileSync } from "node:fs";
import { buildD1RemoteMigrations, buildD1MigrationApplyManifest, D1_MIGRATION_OBJECT_QUERY } from "@/lib/cloudflare/d1/remote";

function fixture(t:test.TestContext) {
  const core=new SqliteD1(),search=new SqliteD1("search");
  t.after(()=>{core.close();search.close();});
  let now=new Date().toISOString();
  const options={clock:()=>now,random:()=>0.5};
  const advance=(seconds=61)=>{now=new Date(Date.parse(now)+seconds*1000).toISOString();};
  const message=(index=-1)=>({schemaVersion:1,type:"e2e-search-repair",outboxId:core.rows("e2e_search_repair_outbox_v1").at(index)!.outbox_id});
  const consume=(index=-1)=>consumeSearchRepair(core,search,message(index),options);
  return {core,search,options,advance,message,consume};
}
async function snapshot(core:SqliteD1) {
  const g=(await currentGenerations(core,[articleId])).get(articleId)!;
  const built=buildSearchProjection(buildSearchProjectionInputFromEligibleRows(
    await readEligibleSourceForArticle(core,articleId),await readTagsForArticleIds(core,[articleId])));
  return {g,document:built.documents[0]??null,fts:built.ftsDocuments[0]??null};
}
const materialized=(search:SqliteD1)=>[search.rows("e2e_search_generation_guards_v1"),search.rows("search_documents"),search.rows("search_fts")];

test("M3 applies exact P3 and both Search sides; duplicate receipt consumes no additional attempts/completion",async(t)=>{
  const f=fixture(t);await publish(f.core,"first");f.advance();
  assert.equal((await f.consume()).status,"awaiting_verification");
  assert.equal(f.search.rows("search_documents").length,1);
  assert.equal(f.search.rows("search_fts").length,1);
  assert.equal(f.core.rows("e2e_search_apply_receipts_v1").length,1);
  assert.equal(f.core.rows("e2e_generation_progress_v1")[0].state,"search_pending");
  assert.equal(f.core.rows("e2e_generation_progress_v1")[0].verified_at,null);
  const before=materialized(f.search);f.advance();
  assert.equal((await f.consume()).status,"awaiting_verification");
  assert.equal(f.core.rows("e2e_search_repair_outbox_v1")[0].attempt_count,1);
  assert.equal(f.core.rows("article_content_versions_p3").length,1);
  assert.deepEqual(materialized(f.search),before);
  assert.deepEqual(f.search.rows("e2e_search_write_authorizations_v1"),[]);
});

test("M3 reverse generation and same-generation stale fence/conflicting identity roll back all Search/FTS",async(t)=>{
  const f=fixture(t);await publish(f.core,"a");const a=await snapshot(f.core);
  await publish(f.core,"b",{e2eApproval:{...approval,policyVersion:"v2"}});f.advance();await f.consume();
  const b=await snapshot(f.core), before=materialized(f.search);
  await assert.rejects(applyGuardedSearchProjection(f.search,searchIdentity(a.g,1),a.document,a.fts,f.options.clock()),/e2e_search_generation_match/);
  assert.deepEqual(materialized(f.search),before);
  await applyGuardedSearchProjection(f.search,searchIdentity(b.g,2),b.document,b.fts,f.options.clock());
  const newer=materialized(f.search);
  await assert.rejects(applyGuardedSearchProjection(f.search,searchIdentity(b.g,1),b.document,b.fts,f.options.clock()),/e2e_search_generation_match/);
  await assert.rejects(applyGuardedSearchProjection(f.search,{...searchIdentity(b.g,3),generationId:"f".repeat(64)},b.document,b.fts,f.options.clock()),/e2e_search_generation_match/);
  assert.deepEqual(materialized(f.search),newer);
});

test("M3 withdrawal persists tombstone and old publish cannot resurrect FTS",async(t)=>{
  const f=fixture(t);const first=await publish(f.core,"a");const a=await snapshot(f.core);f.advance();await f.consume();
  await publish(f.core,"withdraw",{captureLegacy:false,versionId:first.versionId,targetState:"withdrawn"});f.advance();
  assert.equal((await f.consume()).status,"awaiting_verification");
  const before=materialized(f.search);
  assert.equal(f.search.rows("e2e_search_generation_guards_v1")[0].tombstone,1);
  assert.deepEqual(f.search.rows("search_documents"),[]);assert.deepEqual(f.search.rows("search_fts"),[]);
  await assert.rejects(applyGuardedSearchProjection(f.search,searchIdentity(a.g,1),a.document,a.fts,f.options.clock()),/e2e_search_generation_match/);
  assert.deepEqual(materialized(f.search),before);
});

test("M3 legacy plan executor, full rebuild, single sync and raw old document writer cannot overwrite cohort",async(t)=>{
  const f=fixture(t);await publish(f.core,"a");const a=await snapshot(f.core);f.advance();await f.consume();
  const before=materialized(f.search),bindings={WORLDCONS_CORE:f.core,WORLDCONS_SEARCH:f.search};
  await assert.rejects(applySearchProjectionPlan(f.search,planSearchProjectionIncrementalSync([], [a.document!],[a.fts!])),/e2e_search_generation_match/);
  await assert.rejects(applySearchProjectionPlan(f.search,planSearchProjectionFullRebuild([],[])),/e2e_search_generation_match/);
  await assert.rejects(syncSearchProjectionForArticle(bindings,articleId),/e2e_managed_article/);
  assert.throws(()=>f.search.db.exec("DELETE FROM search_documents"),/e2e_search_unguarded_writer/);
  await runNativeSearchProjectionSync(bindings);
  assert.deepEqual(materialized(f.search),before);
});

test("M3 full sync stale removal snapshot cannot delete a newly published protected B",async(t)=>{
  const f=fixture(t);
  f.search.beforeStatement=async(sql)=>{
    if (sql.startsWith("SELECT article_id FROM search_documents ORDER")) {
      f.search.beforeStatement=undefined;await publish(f.core,"b");f.advance();await f.consume();
    }
  };
  await assert.rejects(runNativeSearchProjectionSync({WORLDCONS_CORE:f.core,WORLDCONS_SEARCH:f.search}),/final_count_mismatch/);
  assert.equal(f.search.rows("search_documents").length,1);
  assert.equal(f.search.rows("e2e_search_generation_guards_v1")[0].generation_seq,1);
});

test("M3 Core B/Search A gap and immediate withdrawal are hidden from public search",async(t)=>{
  const f=fixture(t);const first=await publish(f.core,"a");f.advance();await f.consume();
  await assertPublicSearchFreshness(f.core,f.search,[articleId]);
  await publish(f.core,"b",{e2eApproval:{...approval,policyVersion:"v2"}});
  await assert.rejects(assertPublicSearchFreshness(f.core,f.search,[articleId]),/public_projection_pending/);
  f.advance();await f.consume();await assertPublicSearchFreshness(f.core,f.search,[articleId]);
  await publish(f.core,"withdraw",{captureLegacy:false,versionId:first.versionId,targetState:"withdrawn"});
  await assert.rejects(assertPublicSearchFreshness(f.core,f.search,[articleId]),/public_projection_pending/);
});

test("M3 public guard checks are batched and Core failure never falls back to stale Search",async(t)=>{
  const f=fixture(t);await publish(f.core,"a");f.advance();await f.consume();
  f.core.queries=[];f.search.queries=[];
  await assertPublicSearchFreshness(f.core,f.search,[articleId,...Array.from({length:120},(_,i)=>`legacy-${i}`)]);
  assert.ok(f.core.queries.length<10,"bounded batches rather than 121 Core requests");
  assert.ok(f.search.queries.length<5);
  f.core.beforeStatement=()=>{throw new Error("Core unavailable");};
  await assert.rejects(assertPublicSearchFreshness(f.core,f.search,[articleId]),/Core unavailable/);
});

test("M3 mutable drafts never replace approved public P3; withdrawal filters detail/list/source",async(t)=>{
  const f=fixture(t);const first=await publish(f.core,"a");
  f.core.db.exec("UPDATE articles SET korean_title='미승인 초안',cleaned_text='미승인 본문'");
  const approved=await overlayPublicGenerationRows(f.core,f.core.rows("articles"));
  assert.equal(approved[0].korean_title,"시험 판결");assert.notEqual(approved[0].cleaned_text,"미승인 본문");
  await publish(f.core,"withdraw",{captureLegacy:false,versionId:first.versionId,targetState:"withdrawn"});
  assert.deepEqual(await overlayPublicGenerationRows(f.core,f.core.rows("articles")),[]);
});

test("M3 mutable tag/review drift blocks stale public projection and Consumer",async(t)=>{
  const f=fixture(t);await publish(f.core,"a");f.advance();await f.consume();
  f.core.db.exec("UPDATE articles SET review_state='needs_review'");f.advance();
  assert.equal((await f.consume()).status,"blocked");
  await assert.rejects(assertPublicSearchFreshness(f.core,f.search,[articleId]),/public_projection_pending/);
  assert.equal(f.core.rows("e2e_search_repair_outbox_v1")[0].attempt_count,1);
});

test("M3 actual document/FTS corruption with unchanged checksum triggers same-generation repair",async(t)=>{
  const f=fixture(t);await publish(f.core,"a");f.advance();await f.consume();
  f.search.db.exec("UPDATE search_fts SET title='손상 제목'");f.advance();
  assert.equal((await f.consume()).status,"awaiting_verification");
  assert.notEqual(f.search.rows("search_fts")[0].title,"손상 제목");
  assert.equal(f.core.rows("e2e_search_repair_outbox_v1")[0].attempt_count,2);
  assert.equal(f.core.rows("article_content_versions_p3").length,1);
});

test("M3 duplicate concurrent deliveries have one processing owner",async(t)=>{
  const f=fixture(t);await publish(f.core,"a");f.advance();
  const results=await Promise.all([f.consume(),f.consume()]);
  assert.equal(results.filter(r=>r.status==="awaiting_verification").length,1);
  assert.equal(f.core.rows("e2e_search_repair_outbox_v1")[0].attempt_count,1);
  assert.equal(f.search.rows("search_fts").length,1);
});

test("M3 Search batch late failure leaves no partial guard, document or FTS",async(t)=>{
  const f=fixture(t);await publish(f.core,"a");f.advance();f.search.failAtEnd=true;
  assert.equal((await f.consume()).status,"retry");
  assert.deepEqual(materialized(f.search),[[],[],[]]);
  assert.deepEqual(f.core.rows("e2e_search_apply_receipts_v1"),[]);
  assert.equal(f.core.rows("e2e_search_repair_outbox_v1")[0].status,"retry_wait");
  f.search.failAtEnd=false;f.advance();assert.equal((await f.consume()).status,"awaiting_verification");
});

test("M3 Search commit before Core receipt interruption resumes without duplicate FTS or new P3",async(t)=>{
  const f=fixture(t);await publish(f.core,"a");f.advance();
  f.core.beforeBatch=()=>{f.core.beforeBatch=undefined;throw new Error("interrupted after Search commit");};
  assert.equal((await f.consume()).status,"retry");
  assert.equal(f.search.rows("search_documents").length,1);assert.deepEqual(f.core.rows("e2e_search_apply_receipts_v1"),[]);
  f.advance();assert.equal((await f.consume()).status,"awaiting_verification");
  assert.equal(f.search.rows("search_fts").length,1);assert.equal(f.core.rows("article_content_versions_p3").length,1);
});

test("M3 expired owner cannot record receipt; reclaimed fence repairs and owns outcome",async(t)=>{
  const f=fixture(t);await publish(f.core,"a");f.advance();
  f.search.beforeBatch=()=>{f.search.beforeBatch=undefined;f.advance(301);};
  assert.equal((await f.consume()).status,"retry");
  assert.deepEqual(f.core.rows("e2e_search_apply_receipts_v1"),[]);
  await assertPublicSearchFreshness(f.core,f.search,[articleId]); // Exact current data may be visible without an M4 completion receipt.
  assert.equal((await f.consume()).status,"awaiting_verification");
  assert.equal(f.search.rows("e2e_search_generation_guards_v1")[0].fencing_token,2);
});

test("M3 B committed/applied while A is in flight remains unchanged and A gets no receipt",async(t)=>{
  const f=fixture(t);await publish(f.core,"a");f.advance();
  f.search.beforeBatch=async()=>{f.search.beforeBatch=undefined;
    await publish(f.core,"b",{e2eApproval:{...approval,policyVersion:"v2"}});f.advance();await f.consume();
  };
  assert.equal((await f.consume(0)).status,"retry");
  assert.equal(f.search.rows("e2e_search_generation_guards_v1")[0].generation_seq,2);
  assert.equal(f.core.rows("e2e_search_apply_receipts_v1").length,1);
  assert.equal(f.core.rows("e2e_generation_progress_v1")[0].state,"superseded");
});

test("M3 processing budget dead-letters failures; Queue duplicates do not exhaust it",async(t)=>{
  const f=fixture(t);await publish(f.core,"a");f.advance();
  f.core.db.exec("UPDATE e2e_search_repair_outbox_v1 SET attempt_count=7");f.search.failAtEnd=true;
  assert.equal((await f.consume()).status,"dead_letter");
  assert.equal(f.core.rows("e2e_search_repair_outbox_v1")[0].attempt_count,8);
  assert.equal((await f.consume()).status,"terminal");
  assert.equal(f.core.rows("e2e_generation_progress_v1")[0].state,"dead_letter");
});

test("M3 dedicated Queue remains disabled; enabled handler ACK follows durable apply receipt",async(t)=>{
  const f=fixture(t);await publish(f.core,"a");f.advance();let ack=0,retry=0;
  const messages=[{body:f.message(),ack:()=>{ack++;},retry:()=>{retry++;}}];
  const env={WORLDCONS_CORE:f.core,WORLDCONS_SEARCH:f.search};
  await consumeE2ESearchRepairBatch(messages,env);assert.equal(retry,1);assert.equal(f.core.batches,1);
  await consumeE2ESearchRepairBatch(messages,{...env,WORLDCONS_E2E_SEARCH_CONSUMER_ENABLED:"true"});
  assert.equal(ack,1);assert.equal(f.core.rows("e2e_search_apply_receipts_v1").length,1);
  assert.equal(f.core.rows("e2e_generation_progress_v1")[0].verified_at,null);
});

test("M3 real public provider returns approved content/no-store, gap 503 and withdrawn detail 404",async(t)=>{
  const f=fixture(t);
  f.core.db.prepare("UPDATE articles SET summary_json=?").run(JSON.stringify({koreanTitle:"시험 판결",summary:{coreSummary:["승인된 요약"]}}));
  const first=await publish(f.core,"a");f.advance();await f.consume();
  f.core.db.exec("UPDATE articles SET korean_title='미승인 초안',cleaned_text='미승인 본문'");
  const env={ENVIRONMENT:"test",PUBLIC_BASE_URL:"https://fixture.example/api"},dependencies={coreBinding:f.core,searchBinding:f.search};
  const request=()=>handleWorldconsSearchRequest(new Request("https://fixture.example/api/search?q=fixture&mode=fulltext"),env,dependencies);
  const response=await request(),body=await response.json();
  assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal(JSON.stringify(body).includes("미승인 초안"),false);
  assert.equal(body.items.length,1);
  const article=await createD1ArticleReadRepository({binding:f.core}).getArticleBySelect("m1-fixture","detail");
  assert.equal(article?.koreanTitle,"시험 판결");assert.ok(article?.summaryJson);
  await publish(f.core,"b",{captureLegacy:false,versionId:first.versionId,e2eApproval:{...approval,policyVersion:"v2"}});
  assert.equal((await request()).status,503);
  await publish(f.core,"withdraw",{captureLegacy:false,versionId:first.versionId,targetState:"withdrawn"});
  const detail=await handleWorldconsSearchRequest(new Request("https://fixture.example/api/articles/m1-fixture"),env,dependencies);
  assert.equal(detail.status,404);
});

test("M3 expired final attempt and elapsed failure budget reach dead-letter without an extra attempt",async(t)=>{
  for (const expired of [true,false]) {
    const f=fixture(t);await publish(f.core,`exhausted-${expired}`);f.advance();
    f.core.db.prepare(`UPDATE e2e_search_repair_outbox_v1 SET status=?,attempt_count=?,claimed_by=?,lease_expires_at=?,first_failure_at=?`).run(
      expired?"leased":"retry_wait",expired?8:1,expired?"crashed":null,
      expired?new Date(Date.parse(f.options.clock())-1000).toISOString():null,
      new Date(Date.parse(f.options.clock())-7200001).toISOString());
    assert.equal((await f.consume()).status,"dead_letter");
    assert.equal(f.core.rows("e2e_search_repair_outbox_v1")[0].attempt_count,expired?8:1);
    assert.equal(f.core.rows("e2e_generation_progress_v1")[0].state,"dead_letter");
    assert.deepEqual(materialized(f.search),[[],[],[]]);
  }
});

test("M3 public cache re-reads Core schema and bypasses cached content; unavailable Core fails closed",async(t)=>{
  const f=fixture(t);setRuntimeD1Bindings({worldcons_core:f.core,worldcons_search:f.search});
  t.after(clearRuntimeD1Bindings);
  let calls=0;const read=freshnessAwarePublicCache(async()=>++calls,["m3-fixture"],{revalidate:300});
  assert.equal(await read(),1);assert.equal(await read(),2);
  f.core.beforeStatement=()=>{throw new Error("Core unavailable");};
  await assert.rejects(read(),/Core unavailable/);assert.equal(calls,2);
  clearRuntimeD1Bindings();await assert.rejects(read(),/e2e.public_core_unavailable/);
});

test("M3 public check catches first enrollment while Search is being read",async(t)=>{
  const f=fixture(t);let enrolled=false;
  f.search.beforeStatement=async()=>{
    if (enrolled) return;enrolled=true;await publish(f.core,"new-enrollment");
  };
  await assert.rejects(assertPublicSearchFreshness(f.core,f.search,[articleId]),/e2e.public_generation_changed/);
});

test("M3 Core detail drops A when B commits during immutable version hydration",async(t)=>{
  const f=fixture(t);await publish(f.core,"a");
  f.core.beforeStatement=async(sql)=>{
    if (!sql.includes("SELECT v.* FROM article_content_versions_p3 v")) return;
    f.core.beforeStatement=undefined;await publish(f.core,"b",{e2eApproval:{...approval,policyVersion:"v2"}});
  };
  assert.deepEqual(await overlayPublicGenerationRows(f.core,[{id:articleId,korean_title:"초안"}]),[]);
});

test("M3 migration verifier and enabled Consumer reject an incomplete Search trigger deployment",async(t)=>{
  const f=fixture(t);
  const migrations=buildD1RemoteMigrations([{database:"worldcons_search",file:"0002_e2e_generation_guards.sql",
    sql:readFileSync(new URL("../d1/worldcons_search/0002_e2e_generation_guards.sql",import.meta.url),"utf8")}]);
  const runner=async(args:string[])=>{
    if (args[1]==="list") return JSON.stringify([{name:"worldcons_search",uuid:"search-fixture"}]);
    if (args[1]==="info") return JSON.stringify({name:"worldcons_search",uuid:"search-fixture"});
    assert.equal(args.includes("--file"),false);
    return JSON.stringify([{success:true,results:f.search.db.prepare(D1_MIGRATION_OBJECT_QUERY).all()}]);
  };
  assert.equal((await buildD1MigrationApplyManifest({migrations,runner})).targets[0].verified,true);
  f.search.db.exec("DROP TRIGGER e2e_search_document_delete_guard");
  const partial=await buildD1MigrationApplyManifest({migrations,runner});
  assert.equal(partial.targets[0].verified,false);assert.equal(partial.targets[0].pending,1);
  let ack=0;
  await assert.rejects(consumeE2ESearchRepairBatch([{body:{},ack:()=>{ack++;},retry:()=>{}}],{
    WORLDCONS_CORE:f.core,WORLDCONS_SEARCH:f.search,WORLDCONS_E2E_SEARCH_CONSUMER_ENABLED:"true"}),/e2e.consumer_guards_not_ready/);
  assert.equal(ack,0);
});

test("M3 legacy executor reserves guard statements within the D1 100 statement/parameter envelope",async(t)=>{
  const f=fixture(t),plan=planSearchProjectionIncrementalSync([],[],[]);
  plan.statements=Array.from({length:100},(_,i)=>({sql:"DELETE FROM search_fts WHERE article_id=?",params:[`legacy-${i}`]}));
  f.search.beforeBatch=()=>{ /* SqliteD1 checks the actual bound-parameter count. */ };
  const original=f.search.batch.bind(f.search);
  f.search.batch=async(statements)=>{assert.ok(statements.length<=100);return original(statements);};
  assert.equal(await applySearchProjectionPlan(f.search,plan,100),2);
});
