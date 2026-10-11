import assert from "node:assert/strict";
import test from "node:test";
import { SqliteD1 } from "./helpers/e2e-core-fixture";
import { validSummary } from "./helpers/e2e-m4-summary";
import { createIngestStageHandlers,enqueueIngestStageDiscovery,type IngestStageRawBucket } from "../workers/async-pipeline/src/ingest-stage-handlers";
import { consumeIngestStageBatch, type IngestStageHandlerContext } from "../workers/async-pipeline/src/ingest-stage-consumer";
import { dispatchIngestStagePass } from "@/lib/cloudflare/ingest-stages/dispatcher";
import { resolveIngestStageRolloutGate } from "@/lib/cloudflare/ingest-stages/flags";
import { INGEST_STAGE_QUEUES,type IngestStage,type IngestStageQueueMessage } from "@/lib/cloudflare/ingest-stages/contracts";
import { handleWorldconsSearchRequest } from "@/lib/integrations/cclrag2/provider-handler";
import type { NativeCrawlerBindings } from "../workers/async-pipeline/src/native-crawler";
import {reserveDiscoveryCandidates} from "../lib/cloudflare/ingest-stages/discovery-coverage";
import { stagedE2EOptionsFromEnvironment } from "../workers/async-pipeline/src/staged-e2e";

test("M4 new synthetic official FR case flows Discovery-to-Search unattended through real staged handlers and completion ledger",async(t)=>{
  const core=new SqliteD1(),ingest=new SqliteD1("ingest"),search=new SqliteD1("search");
  t.after(()=>{core.close();ingest.close();search.close();});core.db.exec("DELETE FROM articles");
  const store=new Map<string,Uint8Array>();
  const bucket:IngestStageRawBucket={async put(key,value){store.set(key,value);},async get(key){const value=store.get(key);
    return value?{arrayBuffer:async()=>value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength) as ArrayBuffer}:null;}};
  const now=new Date().toISOString(),source="fr-conseil-constitutionnel",detailPath="/decision/2026/2026912QPC.htm";
  const officialFetch:typeof fetch=async(input)=>{
    const url=String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\nCrawl-delay: 0");
    if (url.endsWith("/les-decisions")) return new Response(`<a href="${detailPath}">Décision n° 2026-912 QPC du 10 octobre 2026</a>`);
    if (url.endsWith(detailPath)) return new Response(`<html><main><h1>Décision n° 2026-912 QPC</h1>${"Official constitutional decision on rights and equal protection. ".repeat(70)}</main></html>`);
    throw new Error(`Unexpected synthetic authority URL ${url}`);
  };
  const base="https://fixture.example/api";
  const publicFetch:typeof fetch=async(input)=>handleWorldconsSearchRequest(new Request(String(input)),{
    ENVIRONMENT:"test",PUBLIC_BASE_URL:base},{coreBinding:core,searchBinding:search});
  const handlers=createIngestStageHandlers({crawlerBindings:{WORLDCONS_CORE:core,WORLDCONS_INGEST:ingest,WORLDCONS_RAW:bucket} as unknown as NativeCrawlerBindings,
    rawBucket:bucket,fetch:officialFetch,translation:{async summarize(articleId){
      core.db.prepare(`UPDATE articles SET status='summarized',translation_status='translated',lifecycle_processing_state='complete',summary_json=?,korean_title=?,summarized_at=? WHERE id=?`).run(
        JSON.stringify(validSummary),validSummary.koreanTitle,now,articleId);return {status:"summarized"};}},
    e2e:{sources:[source],search,verification:{apiBaseUrl:base,fetch:publicFetch,deploymentRef:"fixture:synthetic-local-staged"}}});
  let crawlContext:IngestStageHandlerContext|undefined;const realCrawl=handlers.crawl!;
  handlers.crawl=async(context)=>{crawlContext=context;return realCrawl(context);};
  const gate=resolveIngestStageRolloutGate(true,"production","discovery,crawl,normalize,translate,public-judgment,publish,search");
  await enqueueIngestStageDiscovery(ingest,bucket,{sourceKey:source,limit:1,now});
  for (const stage of ["discovery","crawl","normalize","translate","public-judgment","publish","search"] as IngestStage[]) {
    const sent:IngestStageQueueMessage[]=[];
    await dispatchIngestStagePass({ingestDb:ingest,queue:{async send(message){sent.push(message);}},stage,workerId:`m4:${stage}`,limit:1,leaseSeconds:300,now});
    assert.equal(sent.length,1,`${stage} has one durable Queue identity`);let ack=0;
    const result=await consumeIngestStageBatch({queue:INGEST_STAGE_QUEUES[stage],messages:sent.map(body=>({body,ack:()=>{ack++;},retry:()=>{}}))},
      {gate,ingestDb:ingest,coreDb:core,now,handlers,env:{},invalidRetryDelaySeconds:60});
    assert.equal(result.completed,1,`${stage}: ${JSON.stringify(result)}; ${JSON.stringify(ingest.rows("ingest_stage_jobs").map(r=>({stage:r.stage,error:r.last_error_code,summary:r.last_error_summary})))}`);
    assert.equal(ack,1);
    if(stage==="discovery")await reserveDiscoveryCandidates(ingest,bucket,{sources:[source],now,owner:"fixture-reservation",limit:20});
    if (stage==="search") {
      const duplicate=await consumeIngestStageBatch({queue:INGEST_STAGE_QUEUES[stage],messages:sent.map(body=>({body,ack:()=>{},retry:()=>{}}))},
        {gate,ingestDb:ingest,coreDb:core,now,handlers,env:{},invalidRetryDelaySeconds:60});assert.equal(duplicate.completed,0);
    }
  }
  assert.equal(core.rows("articles").length,1);assert.equal(core.rows("article_content_versions_p3").length,1);
  const generation=core.rows("e2e_generations_v1")[0];assert.ok(String(generation.discovery_candidate_id).startsWith("native:"));
  assert.ok(generation.source_evidence_ref);assert.equal(core.rows("e2e_generation_progress_v1")[0].state,"completed_verified");
  assert.equal(core.rows("e2e_verification_evidence_v1").length,1);assert.equal(search.rows("search_fts").length,1);
  assert.equal(ingest.rows("ingest_stage_jobs").filter(row=>row.status!=="succeeded").length,0);
  const originalRef=String(generation.source_evidence_ref),originalBytes=store.get(originalRef)!;
  assert.ok(originalRef.endsWith(`${core.rows("e2e_approval_evidence_v1")[0].source_artifact_hash}.json`));
  const recrawled=await realCrawl({...crawlContext!,now:new Date(Date.parse(now)+60_000).toISOString()});
  assert.equal(recrawled.status,"succeeded");assert.notEqual(recrawled.nextPayloadRef,originalRef);
  assert.deepEqual(store.get(originalRef),originalBytes);assert.ok(store.has(recrawled.nextPayloadRef!));
  console.log(JSON.stringify({event:"m4_local_staged_evidence",scope:"synthetic_local",officialTransport:"fixture",translation:"fixture",
    generation,approvalProof:core.rows("e2e_approval_evidence_v1")[0],verification:core.rows("e2e_verification_evidence_v1")[0],
    stages:ingest.rows("ingest_stage_jobs").map(r=>({id:r.id,stage:r.stage,status:r.status,articleId:r.article_id,sourceKey:r.source_key,payloadRef:r.payload_ref}))}));
});

test("M4 cohort is default off and malformed enabled configuration cannot fall through to legacy publication",(t)=>{
  const search=new SqliteD1("search");t.after(()=>search.close());
  const env={WORLDCONS_SEARCH:search,WORLDCONS_E2E_STAGED_APPROVAL_ENABLED:"true",
    WORLDCONS_E2E_STAGED_SOURCES:"fr-conseil-constitutionnel,es-tribunal-constitucional",
    WORLDCONS_E2E_VERIFIER_ENABLED:"true",WORLDCONS_E2E_VERIFIER_API_BASE_URL:"https://fixture.example/api",
    WORLDCONS_E2E_DEPLOYMENT_REF:"fixture:flags"};
  assert.equal(stagedE2EOptionsFromEnvironment({WORLDCONS_SEARCH:search}),undefined);
  assert.equal(stagedE2EOptionsFromEnvironment(env)?.sources.length,2);
  for (const changes of [{WORLDCONS_E2E_STAGED_SOURCES:""},{WORLDCONS_E2E_STAGED_SOURCES:"unknown"},
    {WORLDCONS_E2E_VERIFIER_ENABLED:"false"},{WORLDCONS_E2E_VERIFIER_API_BASE_URL:"http://fixture.example/api"},
    {WORLDCONS_E2E_DEPLOYMENT_REF:""}]) assert.throws(()=>stagedE2EOptionsFromEnvironment({...env,...changes}));
});
