import assert from "node:assert/strict";
import test from "node:test";
import {SqliteD1} from "./helpers/e2e-core-fixture";
import {claimIngestStageJobs} from "../lib/cloudflare/ingest-stages/repository";
import {captureDiscoverySnapshot,readDiscoverySnapshot,reserveDiscoveryCandidates} from "../lib/cloudflare/ingest-stages/discovery-coverage";
import {createIngestStageHandlers,enqueueIngestStageDiscovery,type IngestStageRawBucket} from "../workers/async-pipeline/src/ingest-stage-handlers";
import {discoverNativeStageCandidates,nativeStageCandidateId,type NativeCrawlerBindings,type NativeStageCandidate} from "../workers/async-pipeline/src/native-crawler";
import type {IngestStageHandlerContext} from "../workers/async-pipeline/src/ingest-stage-consumer";
import {buildIngestStageQueueMessage} from "../lib/cloudflare/ingest-stages/contracts";
const NOW=new Date().toISOString(),SOURCE="fr-conseil-constitutionnel";
const candidate=(n:number):NativeStageCandidate=>({sourceKey:SOURCE,url:"https://www.conseil-constitutionnel.fr/decision/2026/2026"+n+"QPC.htm",title:"Décision n° 2026-"+n+" QPC du 11 octobre 2026",publishedAt:"2026-10-11T00:00:00.000Z",contentType:"decision",metadata:{collection:{strategy:"official-listing"}}});
function fixture(t:{after(fn:()=>void):void}) {
  const core=new SqliteD1(),ingest=new SqliteD1("ingest"),search=new SqliteD1("search");
  t.after(()=>{core.close();ingest.close();search.close();});
  const values=new Map<string,Uint8Array>();
  const bucket:IngestStageRawBucket={async put(key,value){values.set(key,value);},async get(key){const value=values.get(key);return value?{arrayBuffer:async()=>value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength) as ArrayBuffer}:null;}};
  const bindings={WORLDCONS_CORE:core,WORLDCONS_INGEST:ingest,WORLDCONS_RAW:bucket} as unknown as NativeCrawlerBindings;
  const owner=(context:IngestStageHandlerContext)=>({jobId:context.job.id,fencingToken:context.message.fencingToken,now:context.now});
  async function context(day=NOW) {
    await enqueueIngestStageDiscovery(ingest,bucket,{sourceKey:SOURCE,limit:1,now:day});
    const jobs=await claimIngestStageJobs(ingest,{stage:"discovery",workerId:"fixture",limit:1,leaseSeconds:300,now:day});
    const job=jobs[0];assert.ok(job);
    const message=buildIngestStageQueueMessage({jobId:job.id,articleId:job.article_id,stage:job.stage,sourceVersion:job.source_version,contentHash:job.content_hash,fencingToken:job.claimed_fencing_token!,enqueuedAt:day});
    return {env:{},coreDb:core,ingestDb:ingest,message,job,now:day} as IngestStageHandlerContext;
  }
  return {core,ingest,search,values,bucket,bindings,owner,context};
}

test("M5 limit=1 repeated known head retains every observed candidate and resumes reservation in bounded ticks",async t=>{
  const f=fixture(t),list=[candidate(1200),candidate(1201),candidate(1202)];
  f.core.db.prepare("UPDATE articles SET canonical_url=?,fetched_at=?").run(list[0].url,NOW);
  let listingFetches=0;
  const fetcher:typeof fetch=async input=>{const url=String(input);if(url.endsWith("robots.txt"))return new Response("User-agent: *\nAllow: /\nCrawl-delay: 0");
    if(url.endsWith("les-decisions")){listingFetches++;return new Response(list.map(c=>'<a href="'+c.url+'">'+c.title+'</a>').join("\n"));}throw Error("unexpected fetch "+url);};
  const handlers=createIngestStageHandlers({crawlerBindings:f.bindings,rawBucket:f.bucket,fetch:fetcher,now:()=>NOW,
    e2e:{sources:[SOURCE],search:f.search,verification:{apiBaseUrl:"https://fixture.example/api",deploymentRef:"fixture:discovery"}}});
  const context=await f.context(),result=await handlers.discovery!(context);
  assert.equal(result.status,"succeeded");assert.equal(result.registerNext,false);
  assert.equal(f.ingest.rows("ingest_discovery_items_v1").length,3);
  assert.equal(f.ingest.rows("ingest_stage_jobs").filter(x=>x.stage==="crawl").length,0,"capture precedes background reservation");
  const snapshot=(await readDiscoverySnapshot(f.ingest,f.bucket,context.job.id))!;
  assert.equal(snapshot.scope.countryCorpusComplete,false,"bounded observation is not country-wide coverage proof");
  assert.equal(snapshot.items.filter(x=>x.coveredExisting).length,1);
  for(const item of snapshot.items)assert.equal(item.candidateId,await nativeStageCandidateId(SOURCE,item.url));
  assert.equal((await reserveDiscoveryCandidates(f.ingest,f.bucket,{sources:[SOURCE],now:NOW,owner:"tick-1",limit:1})).pendingCount,1);
  assert.equal((await reserveDiscoveryCandidates(f.ingest,f.bucket,{sources:[SOURCE],now:NOW,owner:"tick-2",limit:1})).pendingCount,0);
  const jobs=f.ingest.rows("ingest_stage_jobs").filter(x=>x.stage==="crawl");assert.equal(jobs.length,2);assert.ok(jobs.every(x=>x.priority===50));
  assert.equal(f.ingest.rows("ingest_discovery_scans_v1")[0].status,"reserved");
  list.splice(0,list.length,candidate(1300));
  await handlers.discovery!(context);assert.equal(listingFetches,1,"retry uses committed snapshot, not changed official listing");
  assert.equal((await readDiscoverySnapshot(f.ingest,f.bucket,context.job.id))!.items.length,3);
  const tomorrow=new Date(Date.parse(NOW)+86400000).toISOString(),again=await f.context(tomorrow);
  await captureDiscoverySnapshot(f.ingest,f.core,f.bucket,f.owner(again),{sourceKey:SOURCE,candidates:[candidate(1200),candidate(1201),candidate(1202)],recheckLimit:1,rangeDays:14});
  await reserveDiscoveryCandidates(f.ingest,f.bucket,{sources:[SOURCE],now:tomorrow,owner:"next-day",limit:20});
  assert.equal(f.ingest.rows("ingest_stage_jobs").filter(x=>x.stage==="crawl").length,2,"same captured candidate does not grow a daily duplicate backlog");
});

test("M5 capture crash after manifest pin resumes the first immutable snapshot",async t=>{
  const f=fixture(t),context=await f.context(),candidates=[candidate(1201),candidate(1202)];let calls=0;
  f.ingest.beforeBatch=()=>{if(++calls===2)throw Error("injected item capture failure");};
  await assert.rejects(captureDiscoverySnapshot(f.ingest,f.core,f.bucket,f.owner(context),{sourceKey:SOURCE,candidates,recheckLimit:1,rangeDays:14}),/injected/);
  assert.equal(f.ingest.rows("ingest_discovery_scans_v1")[0].status,"capturing");assert.equal(f.ingest.rows("ingest_discovery_items_v1").length,0);
  f.ingest.beforeBatch=undefined;
  const resumed=await captureDiscoverySnapshot(f.ingest,f.core,f.bucket,f.owner(context),{sourceKey:SOURCE,candidates:[candidate(1300)],recheckLimit:1,rangeDays:14});
  assert.deepEqual(resumed.items.map(x=>x.url),candidates.map(x=>x.url));assert.equal(f.ingest.rows("ingest_discovery_items_v1").length,2);
  assert.equal(f.ingest.rows("ingest_discovery_commit_guards_v1").length,0);
});

test("M5 crash after crawl reservation before journal receipt leaves replayable work, not a lost candidate",async t=>{
  const f=fixture(t),context=await f.context();
  await captureDiscoverySnapshot(f.ingest,f.core,f.bucket,f.owner(context),{sourceKey:SOURCE,candidates:[candidate(1201),candidate(1202)],recheckLimit:1,rangeDays:14});
  f.ingest.beforeBatch=()=>{throw Error("injected reservation receipt crash");};
  await assert.rejects(reserveDiscoveryCandidates(f.ingest,f.bucket,{sources:[SOURCE],now:NOW,owner:"crashed",limit:1}),/injected/);
  assert.equal(f.ingest.rows("ingest_stage_jobs").filter(x=>x.stage==="crawl").length,1);
  assert.ok(f.ingest.rows("ingest_discovery_items_v1").every(x=>x.status==="pending"));
  f.ingest.beforeBatch=undefined;
  const later=new Date(Date.parse(NOW)+301000).toISOString();
  const resumed=await reserveDiscoveryCandidates(f.ingest,f.bucket,{sources:[SOURCE],now:later,owner:"resumed",limit:20});
  assert.equal(resumed.pendingCount,0);assert.equal(f.ingest.rows("ingest_stage_jobs").filter(x=>x.stage==="crawl").length,2);
  assert.equal(f.ingest.rows("ingest_discovery_scans_v1")[0].reservation_fence,2);
  assert.ok(f.ingest.rows("ingest_discovery_items_v1").every(x=>x.crawl_job_id));
});

test("M5 stale reservation fence cannot record success or overwrite a newer owner",async t=>{
  const f=fixture(t),context=await f.context();
  await captureDiscoverySnapshot(f.ingest,f.core,f.bucket,f.owner(context),{sourceKey:SOURCE,candidates:[candidate(1201)],recheckLimit:1,rangeDays:14});
  f.ingest.beforeBatch=()=>{f.ingest.db.exec("UPDATE ingest_discovery_scans_v1 SET reservation_fence=reservation_fence+1,reservation_owner='newer-owner'");};
  await assert.rejects(reserveDiscoveryCandidates(f.ingest,f.bucket,{sources:[SOURCE],now:NOW,owner:"stale",limit:20}),/CHECK constraint/);
  assert.equal(f.ingest.rows("ingest_discovery_scans_v1")[0].reservation_owner,"newer-owner");
  assert.equal(f.ingest.rows("ingest_discovery_items_v1")[0].status,"pending");
  assert.equal(f.ingest.rows("ingest_discovery_commit_guards_v1").length,0);
});

test("M5 expired discovery owner cannot activate a candidate manifest",async t=>{
  const f=fixture(t),context=await f.context();f.ingest.db.exec("UPDATE ingest_stage_jobs SET lease_expires_at='2000-01-01T00:00:00Z'");
  await assert.rejects(captureDiscoverySnapshot(f.ingest,f.core,f.bucket,f.owner(context),{sourceKey:SOURCE,candidates:[candidate(1201)],recheckLimit:1,rangeDays:14}),/CHECK constraint/);
  assert.equal(f.ingest.rows("ingest_discovery_scans_v1").length,0);assert.equal(f.ingest.rows("ingest_stage_jobs").filter(x=>x.stage==="crawl").length,0);
});

test("M5 ES protected enumeration retains multiple observed hits while legacy limit remains bounded",async t=>{
  const f=fixture(t);const fetcher:typeof fetch=async input=>String(input).endsWith("robots.txt")?new Response("User-agent: *\nAllow: /\nCrawl-delay: 0"):
    new Response('<time>2026-10-11</time><a href="/HJ/es/Resolucion/Show/32126">AUTO 43/2026</a><a href="/HJ/es/Resolucion/Show/32136">SENTENCIA 59/2026</a>');
  const options={fetch:fetcher,now:new Date(NOW),limit:1};
  assert.equal((await discoverNativeStageCandidates("es-tribunal-constitucional",f.bindings,options)).length,1);
  assert.equal((await discoverNativeStageCandidates("es-tribunal-constitucional",f.bindings,{...options,retainAllObserved:true})).length,2);
});

test("M5 known-source periodic recheck budget does not suppress new candidate reservation",async t=>{
  const f=fixture(t),context=await f.context();
  const template=f.core.rows("articles")[0],copy:Record<string,unknown>={...template,id:"22222222-2222-4222-a222-222222222222",slug:"known-two",canonical_url:candidate(1202).url,fetched_at:"2026-09-01T00:00:00Z"};
  const columns=Object.keys(copy);f.core.db.prepare("INSERT INTO articles ("+columns.join(",")+") VALUES ("+columns.map(()=>"?").join(",")+")").run(...columns.map(x=>copy[x] as never));
  f.core.db.prepare("UPDATE articles SET canonical_url=?,fetched_at='2026-09-02T00:00:00Z' WHERE id=?").run(candidate(1201).url,template.id);
  const snapshot=await captureDiscoverySnapshot(f.ingest,f.core,f.bucket,f.owner(context),{sourceKey:SOURCE,candidates:[candidate(1201),candidate(1202),candidate(1203)],recheckLimit:1,rangeDays:14});
  assert.equal(snapshot.items.filter(x=>x.coveredExisting).length,1);assert.equal(snapshot.items.filter(x=>x.sourceVersion.includes(":recheck:")).length,1);
  await reserveDiscoveryCandidates(f.ingest,f.bucket,{sources:[SOURCE],now:NOW,owner:"tick",limit:1});
  const job=f.ingest.rows("ingest_stage_jobs").find(x=>x.stage==="crawl")!;assert.equal(job.article_id,await nativeStageCandidateId(SOURCE,candidate(1203).url));assert.equal(job.priority,50);
});

test("M5 mismatched parent source cannot activate another country's snapshot",async t=>{
  const f=fixture(t),context=await f.context();
  await assert.rejects(captureDiscoverySnapshot(f.ingest,f.core,f.bucket,f.owner(context),{sourceKey:"es-tribunal-constitucional",candidates:[],recheckLimit:1,rangeDays:180}),/CHECK constraint/);
  assert.equal(f.ingest.rows("ingest_discovery_scans_v1").length,0);
});
