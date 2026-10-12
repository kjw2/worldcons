import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {SqliteD1,articleId,input,approval} from "./helpers/e2e-core-fixture";
import {validSummary} from "./helpers/e2e-m4-summary";
import {recordHumanApproval,readHumanReviewSnapshot} from "../lib/cloudflare/e2e/manual-approval";
import {transitionArticlePublicationInD1} from "../lib/cloudflare/core-write/authority";
import {consumeSearchRepair} from "../lib/cloudflare/e2e/search-repair-consumer";
import {verifySearchRepair} from "../lib/cloudflare/e2e/search-verification";
import {handleWorldconsSearchRequest} from "../lib/integrations/cclrag2/provider-handler";
import {currentGenerations} from "../lib/cloudflare/e2e/generation-state";
import {approvalIdentity,APPROVAL_HASH_SCHEMA,LEGACY_APPROVAL_HASH_SCHEMA} from "../lib/cloudflare/e2e/contracts";
function prepare(db:SqliteD1){for(const file of ['0008_e2e_core_writer_guards.sql','0009_e2e_source_ownership.sql'])db.db.exec(readFileSync(new URL('../d1/worldcons_core/'+file,import.meta.url),'utf8'));
 db.db.exec("UPDATE e2e_source_policies_v1 SET required=1");db.db.prepare("UPDATE articles SET summary_json=?,cleaned_text=?").run(JSON.stringify(validSummary),'Official decision text. '.repeat(150));}

test('M5 source owner blocks first unapproved publication, not just managed heads',async t=>{const db=new SqliteD1();t.after(()=>db.close());prepare(db);
 const denied=await transitionArticlePublicationInD1(db,input(db,'unapproved',{e2eApproval:undefined}));assert.ok(!denied.ok);assert.equal(db.rows('article_publications_p3').length,0);
 assert.throws(()=>db.db.exec("INSERT INTO article_publications_p3(id,article_id,state,version_id,revision,created_at,updated_at) VALUES ('x','"+articleId+"','published','bogus',1,'now','now')"),/e2e_source_owner_required/);
 assert.throws(()=>db.db.exec("UPDATE articles SET source_key='de-bverfg'"),/e2e_source_identity_immutable/);
});

test('M5 stale human preview cannot approve a changed draft; exact reviewed snapshot publishes with generation/outbox',async t=>{const db=new SqliteD1();t.after(()=>db.close());prepare(db);const before=await readHumanReviewSnapshot(db,{articleId});
 db.db.exec("UPDATE articles SET korean_title='변경된 판결 제목'");
 await assert.rejects(recordHumanApproval(db,{articleId,actorId:'fixture:human',expectedSnapshotHash:before.identity.approvalSnapshotHash,note:'Read exact source and summary',now:new Date().toISOString()}),/snapshot_stale/);
 assert.equal(db.rows('e2e_approval_evidence_v1').length,0);
 const current=await readHumanReviewSnapshot(db,{articleId});const context=await recordHumanApproval(db,{articleId,actorId:'fixture:human',expectedSnapshotHash:current.identity.approvalSnapshotHash,note:'Read exact source and summary',now:new Date().toISOString()});
 const result=await transitionArticlePublicationInD1(db,input(db,'human',{actorType:'human',e2eApproval:context}));assert.ok(result.ok,JSON.stringify(result));assert.equal(result.data.generation!.generationSeq,1);
 assert.equal(db.rows('e2e_generations_v1')[0].approval_mode,'human');assert.equal(db.rows('e2e_search_repair_outbox_v1').length,1);assert.equal(db.rows('e2e_core_write_authorizations_v1').length,0);
 assert.throws(()=>db.db.exec("UPDATE article_publications_p3 SET state='withdrawn'"),/e2e_core_|e2e_source_/);
});

test('M5 hash v2 excludes AI accounting while v1 remains verifiable; time/model-only refresh has no P3/generation/outbox growth',async t=>{const db=new SqliteD1();t.after(()=>db.close());
 const content={...validSummary,aiMetadata:{provider:'fixture',model:'first',generatedAt:'2026-10-01'}};db.db.prepare('UPDATE articles SET summary_json=?').run(JSON.stringify(content));
 const row=db.rows('articles')[0],v1=await approvalIdentity(articleId,row,approval.policyVersion,LEGACY_APPROVAL_HASH_SCHEMA),v2=await approvalIdentity(articleId,row,approval.policyVersion,APPROVAL_HASH_SCHEMA);
 const context={...approval,hashSchema:APPROVAL_HASH_SCHEMA} as const;const first=await transitionArticlePublicationInD1(db,input(db,'first-v2',{e2eApproval:context}));assert.ok(first.ok);
 db.db.prepare("UPDATE articles SET summary_json=?,fetched_at='2026-10-11T23:00:00Z',summarized_at='2026-10-11T23:01:00Z'").run(JSON.stringify({...content,aiMetadata:{provider:'fixture',model:'second',generatedAt:'2026-10-11'}}));
 const changed=db.rows('articles')[0];assert.notEqual((await approvalIdentity(articleId,changed,approval.policyVersion,LEGACY_APPROVAL_HASH_SCHEMA)).approvalSnapshotHash,v1.approvalSnapshotHash);
 assert.equal((await approvalIdentity(articleId,changed,approval.policyVersion,APPROVAL_HASH_SCHEMA)).approvalSnapshotHash,v2.approvalSnapshotHash);
 const replay=await transitionArticlePublicationInD1(db,input(db,'refresh-v2',{e2eApproval:context}));assert.ok(replay.ok);assert.equal(replay.data.versionId,first.data.versionId);assert.equal(replay.data.generation!.created,false);
 for(const table of ['article_content_versions_p3','e2e_generations_v1','e2e_search_repair_outbox_v1'])assert.equal(db.rows(table).length,1);
});

test('M5 removal authority works for legacy article and ignores later private heads/tags without approving a body',async t=>{const db=new SqliteD1();t.after(()=>db.close());
 const initial=await transitionArticlePublicationInD1(db,input(db,'legacy',{e2eApproval:undefined}));assert.ok(initial.ok);prepare(db);
 const removed=await transitionArticlePublicationInD1(db,input(db,'remove',{e2eApproval:undefined,actorType:'system',captureLegacy:false,versionId:initial.data.versionId,targetState:'withdrawn'}));assert.ok(removed.ok,JSON.stringify(removed));
 const proof=JSON.parse(String(db.rows('e2e_approval_evidence_v1')[0].evidence_document));assert.equal(proof.noPublicApproval,true);assert.equal(proof.schema,'worldcons.removal-authority.v1');
 db.db.exec("UPDATE articles SET review_state='closed_private'");assert.equal((await currentGenerations(db,[articleId])).get(articleId)!.input_current,true);
 const revive=await transitionArticlePublicationInD1(db,input(db,'revive',{e2eApproval:undefined}));assert.ok(!revive.ok);assert.equal(db.rows('article_publications_p3')[0].state,'withdrawn');
});

test('M5 human-reviewed publication verifies actual Search/FTS/API; forged human proof cannot complete',async t=>{
 const core=new SqliteD1(),search=new SqliteD1('search');t.after(()=>{core.close();search.close();});prepare(core);
 core.db.prepare("UPDATE articles SET original_title=?,source_metadata=json_set(source_metadata,'$.caseNumber',?)").run('Décision n° 2026-912 QPC','2026-912 QPC');
 const preview=await readHumanReviewSnapshot(core,{articleId}),context=await recordHumanApproval(core,{articleId,actorId:'fixture:human',expectedSnapshotHash:preview.identity.approvalSnapshotHash,note:'Reviewed full official source and Korean summary.',now:new Date().toISOString()});
 const result=await transitionArticlePublicationInD1(core,input(core,'human-e2e',{actorType:'human',e2eApproval:context}));assert.ok(result.ok,JSON.stringify(result));
 const message={schemaVersion:1,type:'e2e-search-repair',outboxId:result.data.generation!.searchRepairOutboxId};
 assert.equal((await consumeSearchRepair(core,search,message)).status,'awaiting_verification');
 const base='https://fixture.example/api',fetcher:typeof fetch=async request=>handleWorldconsSearchRequest(new Request(String(request)),{ENVIRONMENT:'test',PUBLIC_BASE_URL:base},{coreBinding:core,searchBinding:search});
 const proof=JSON.parse(String(core.rows('e2e_approval_evidence_v1')[0].evidence_document));const original=JSON.stringify(proof);
 proof.actorId='';core.db.prepare('UPDATE e2e_approval_evidence_v1 SET evidence_document=?').run(JSON.stringify(proof));
 assert.notEqual((await verifySearchRepair(core,search,message,{apiBaseUrl:base,fetch:fetcher,deploymentRef:'fixture:human-e2e'})).status,'completed_verified');assert.equal(core.rows('e2e_verification_evidence_v1').length,0);
 core.db.prepare('UPDATE e2e_approval_evidence_v1 SET evidence_document=?').run(original);core.db.exec("UPDATE e2e_verification_jobs_v1 SET next_attempt_at='2000-01-01T00:00:00Z'");
 const verified=await verifySearchRepair(core,search,message,{apiBaseUrl:base,fetch:fetcher,deploymentRef:'fixture:human-e2e'});assert.equal(verified.status,'completed_verified');
 assert.equal(core.rows('e2e_verification_evidence_v1').length,1);assert.equal(search.rows('search_fts').length,1);
});

test('M5 completed projection damage creates a fresh verification epoch without a new P3 version or lost evidence',async t=>{
 const core=new SqliteD1(),search=new SqliteD1('search');t.after(()=>{core.close();search.close();});prepare(core);
 core.db.prepare("UPDATE articles SET original_title=?,source_metadata=json_set(source_metadata,'$.caseNumber',?)").run('Décision n° 2026-912 QPC','2026-912 QPC');
 const preview=await readHumanReviewSnapshot(core,{articleId}),context=await recordHumanApproval(core,{articleId,actorId:'fixture:human',expectedSnapshotHash:preview.identity.approvalSnapshotHash,now:new Date().toISOString()});
 const result=await transitionArticlePublicationInD1(core,input(core,'human-repair',{actorType:'human',e2eApproval:context}));assert.ok(result.ok);
 const message={schemaVersion:1,type:'e2e-search-repair',outboxId:result.data.generation!.searchRepairOutboxId};await consumeSearchRepair(core,search,message);
 const base='https://fixture.example/api',fetcher:typeof fetch=async request=>handleWorldconsSearchRequest(new Request(String(request)),{ENVIRONMENT:'test',PUBLIC_BASE_URL:base},{coreBinding:core,searchBinding:search});
 const options={apiBaseUrl:base,fetch:fetcher,deploymentRef:'fixture:repair'};assert.equal((await verifySearchRepair(core,search,message,options)).status,'completed_verified');
 const old=core.rows('e2e_verification_evidence_v1')[0];search.db.exec("UPDATE search_fts SET title='corrupted physical FTS'");
 const {syncSearchProjectionForArticle,runNativeSearchProjectionSync}=await import('../lib/cloudflare/search-projection/d1-sync');
 await syncSearchProjectionForArticle({WORLDCONS_CORE:core,WORLDCONS_SEARCH:search},articleId);
 assert.equal(core.rows('article_content_versions_p3').length,1);assert.equal(core.rows('e2e_generations_v1').length,2);
 assert.equal(Number(core.rows('article_publications_p3')[0].revision),result.data.publicationRevision+1);assert.deepEqual(core.rows('e2e_verification_evidence_v1')[0],old);
 const next={...message,outboxId:String(core.rows('e2e_search_repair_outbox_v1')[1].outbox_id)};assert.equal((await verifySearchRepair(core,search,next,options)).status,'completed_verified');
 await runNativeSearchProjectionSync({WORLDCONS_CORE:core,WORLDCONS_SEARCH:search});assert.equal(core.rows('e2e_generations_v1').length,2);assert.equal(search.rows('search_fts').length,1);assert.equal(core.rows('e2e_verification_evidence_v1').length,2);
});

test('M5 active legacy source publication cannot move to another article or be cascade-deleted',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());const initial=await transitionArticlePublicationInD1(db,input(db,'legacy-first',{e2eApproval:undefined}));assert.ok(initial.ok);prepare(db);
 assert.throws(()=>db.db.exec("UPDATE article_publications_p3 SET article_id='other'"),/e2e_source_owner_required/);
 assert.throws(()=>db.db.exec("DELETE FROM articles"),/e2e_source_owner_required/);
 assert.throws(()=>db.db.exec("UPDATE article_content_versions_p3 SET authority_evidence_hash='changed'"),/e2e_core_immutable_version/);
 assert.equal(db.rows('article_publications_p3')[0].article_id,articleId);
});

test('M5 global publication drain filters protected sources before LIMIT and leaves capacity for other countries',async t=>{
 const db=new SqliteD1();t.after(()=>db.close());prepare(db);
 const {setRuntimeD1Bindings}=await import('../lib/cloudflare/d1/runtime-binding');const {runD1PublicationDrain}=await import('../lib/cloudflare/publication/d1-publication-drain');
 setRuntimeD1Bindings({worldcons_core:db});t.after(()=>setRuntimeD1Bindings({}));
 const row={...db.rows('articles')[0],id:'22222222-2222-4222-a222-222222222222',slug:'de-fixture',source_key:'de-bverfg',jurisdiction:'DE',canonical_url:'https://www.bundesverfassungsgericht.de/fixture',original_url:'https://www.bundesverfassungsgericht.de/fixture',summarized_at:'2026-10-12T01:00:00Z'};
 const columns=Object.keys(row);db.db.prepare('INSERT INTO articles('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...Object.values(row) as never[]);
 const result=await runD1PublicationDrain({limit:1});assert.equal(result.selectedCount,1);assert.equal(result.publishedCount,1,JSON.stringify(result));assert.equal(result.remainingCount,0);
 assert.equal(db.rows('article_publications_p3')[0].article_id,row.id);assert.equal(db.rows('articles').find(x=>x.id===articleId)!.status,'summarized');
});

test('M5 HJ ACTION/language URL aliases reuse one Core article; older captured source never replaces newer bytes',async t=>{
 const core=new SqliteD1(),ingest=new SqliteD1('ingest');t.after(()=>{core.close();ingest.close();});
 const {persistNativeStageRecord,canonicalNativeArticleUrl}=await import('../workers/async-pipeline/src/native-crawler');
 const base='https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/32085',text='Official full decision text. '.repeat(150);
 const {createHash}=await import('node:crypto');const hash=createHash('sha256').update(text.replace(/\s+/g,' ').trim()).digest('hex');
 core.db.prepare("UPDATE articles SET source_key='es-tribunal-constitucional',canonical_url=?,original_url=?,original_title='SENTENCIA 34/2026',cleaned_text=?,content_hash=?,fetched_at='2026-10-12T03:00:00Z'").run(base,base,text.trim(),hash);
 const candidate={sourceKey:'es-tribunal-constitucional' as const,url:base+'?ACTION=disposiciones-citadas',title:'SENTENCIA 34/2026',contentType:'decision' as const,metadata:{hjId:'32085',collection:{publishable:true,sourceUrlVerified:true,sourceTextAvailable:true,strictSourceTextAvailable:true}}};
 const bindings={WORLDCONS_CORE:core,WORLDCONS_INGEST:ingest,WORLDCONS_RAW:{async put(){}}} as unknown as import('../workers/async-pipeline/src/native-crawler').NativeCrawlerBindings;
 assert.equal(canonicalNativeArticleUrl(candidate.sourceKey,'https://hj.tribunalconstitucional.es/es/Resolucion/Show/32085?ACTION=otro'),base);
 const result=await persistNativeStageRecord(candidate,text,bindings,{runId:'fixture:alias',fetchedAt:'2026-10-12T04:00:00Z'});assert.equal(result.articleId,articleId);assert.equal(core.rows('articles').length,1);
 const before=core.rows('articles')[0];const old=await persistNativeStageRecord(candidate,'Old different source text. '.repeat(150),bindings,{runId:'fixture:delayed',fetchedAt:'2026-10-12T02:00:00Z'});
 assert.equal(old.outcome,'preserved');assert.deepEqual(core.rows('articles')[0],before);
});
