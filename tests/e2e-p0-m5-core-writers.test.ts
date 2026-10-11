import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { transitionArticlePublicationInD1, deleteCoreCanaryArticleFromD1 } from "@/lib/cloudflare/core-write/authority";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { currentGenerations } from "@/lib/cloudflare/e2e/generation-state";
import { SqliteD1, articleId, input, publish } from "./helpers/e2e-core-fixture";
const migration=readFileSync(new URL("../d1/worldcons_core/0008_e2e_core_writer_guards.sql",import.meta.url),"utf8");
function fixture(){const db=new SqliteD1();db.db.exec(migration);return db;}

test("M5 Core: old head/publication/backfill/delete writes cannot bypass the protected transaction",async(t)=>{
  const db=fixture();t.after(()=>db.close());const first=await publish(db,"protected");
  for(const sql of ["UPDATE article_version_heads_p3 SET current_revision='999'",
    "UPDATE article_revision_heads_v4 SET current_revision='999'",
    "UPDATE article_publications_p3 SET state='withdrawn'",
    "DELETE FROM e2e_generation_heads_v1","DELETE FROM articles",
    "UPDATE article_content_versions_p3 SET summary_json='{}'","DELETE FROM article_content_versions_p3"])
    assert.throws(()=>db.db.exec(sql),/e2e_core_/);
  await assert.rejects(deleteCoreCanaryArticleFromD1(db,articleId),/e2e_core_/);
  assert.equal(db.rows("e2e_core_write_authorizations_v1").length,0);
  const legacy=input(db,"legacy-refresh",{e2eApproval:undefined});
  const result=await transitionArticlePublicationInD1(db,legacy);assert.ok(!result.ok);assert.equal(result.error.code,"ineligible");
  assert.equal(db.rows("article_content_versions_p3").length,1);
  db.db.exec("UPDATE articles SET korean_title='새로운 승인 제목'");const second=await publish(db,"protected-revision");
  assert.equal(second.versionRevision,first.versionRevision+1);assert.equal(second.generation!.generationSeq,2);
  assert.equal(db.rows("e2e_core_write_authorizations_v1").length,0);
  db.db.exec("UPDATE articles SET korean_title='실패하는 승인 제목'");db.failAtEnd=true;
  const failed=await transitionArticlePublicationInD1(db,input(db,"failed"));assert.ok(!failed.ok);
  assert.equal(db.rows("article_content_versions_p3").length,2);assert.equal(db.rows("e2e_core_write_authorizations_v1").length,0);
  assert.equal(db.rows("e2e_search_repair_outbox_v1").length,2);
});

test("M5 Core: human withdrawal without new approval creates generation and durable remove outbox",async(t)=>{
  const db=fixture();t.after(()=>db.close());const first=await publish(db,"published");
  db.db.exec("UPDATE articles SET review_state='blocked'");
  const withdrawn=await transitionArticlePublicationInD1(db,input(db,"human-withdraw",{e2eApproval:undefined,
    actorType:"human",captureLegacy:false,versionId:first.versionId,targetState:"withdrawn"}));
  assert.ok(withdrawn.ok,JSON.stringify(withdrawn));assert.equal(withdrawn.data.generation!.generationSeq,2);
  assert.equal(db.rows("e2e_search_repair_outbox_v1")[1].operation,"remove");
  assert.equal((await currentGenerations(db,[articleId])).get(articleId)!.input_current,true);
  assert.equal(db.rows("e2e_core_write_authorizations_v1").length,0);
});

test("M5 workerd: actual D1 triggers, authorization FK cleanup and legacy rollback protection",async(t)=>{
  const require=createRequire(import.meta.url);
  const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve("wrangler/package.json"))("miniflare");
  const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default { fetch(){return new Response("fixture")} }',
    compatibilityDate:"2026-09-20",d1Databases:{CORE:"m5-isolated-core"},cf:false,unsafeRegisterWorker:false}));
  t.after(async()=>{await runtime.dispose();});const core:D1RuntimeDatabase=await runtime.getD1Database("CORE");
  const seed=fixture();t.after(()=>seed.close());
  for(const row of seed.db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all())
    await core.prepare(String(row.sql)).all();
  const article=seed.rows("articles")[0],columns=Object.keys(article);
  await core.prepare('INSERT INTO articles ('+columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')').bind(...Object.values(article)).all();
  const first=await transitionArticlePublicationInD1(core,input(seed,"workerd-first"));assert.ok(first.ok,JSON.stringify(first));
  await assert.rejects(core.prepare("UPDATE article_revision_heads_v4 SET current_revision='99'").all(),/e2e_core_unguarded_writer/);
  await assert.rejects(core.prepare("DELETE FROM articles").all(),/e2e_core_managed_article_delete/);
  await core.prepare("UPDATE articles SET korean_title='다음 개정'").all();
  const second=await transitionArticlePublicationInD1(core,{...input(seed,"workerd-next"),expectedVersionRevision:first.data.versionRevision,
    expectedPublicationRevision:first.data.publicationRevision});assert.ok(second.ok,JSON.stringify(second));
  assert.equal(second.data.generation!.generationSeq,2);
  assert.equal((await core.prepare("SELECT count(*) n FROM e2e_core_write_authorizations_v1").all()).results![0].n,0);
  assert.equal((await core.prepare("SELECT count(*) n FROM e2e_commit_guards_v1").all()).results![0].n,0);
});
