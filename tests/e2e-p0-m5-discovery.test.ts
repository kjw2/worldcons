import assert from "node:assert/strict";
import test from "node:test";
import {SqliteD1} from "./helpers/e2e-core-fixture";
import {claimIngestStageJobs,completeIngestStageJob,failIngestStageJob,registerIngestStageJob} from "../lib/cloudflare/ingest-stages/repository";
import {captureDiscoverySnapshot,isTransientCrawlDeadLetter,readDiscoverySnapshot,reserveDiscoveryCandidates} from "../lib/cloudflare/ingest-stages/discovery-coverage";
import {createIngestStageHandlers,enqueueIngestStageDiscovery,type IngestStageRawBucket} from "../workers/async-pipeline/src/ingest-stage-handlers";
import {discoverNativeStageCandidates,nativeStageCandidateId,type NativeCrawlerBindings,type NativeStageCandidate} from "../workers/async-pipeline/src/native-crawler";
import type {IngestStageHandlerContext} from "../workers/async-pipeline/src/ingest-stage-consumer";
import {buildIngestStageQueueMessage} from "../lib/cloudflare/ingest-stages/contracts";
// Freeze this fixture within the October 11 candidate's 14-day discovery
// window. Wall-clock time made the test fail after October 25, 2026.
const NOW="2026-10-20T00:00:00.000Z",SOURCE="fr-conseil-constitutionnel";
const candidate=(n:number):NativeStageCandidate=>({sourceKey:SOURCE,url:"https://www.conseil-constitutionnel.fr/decision/2026/2026"+n+"QPC.htm",title:"D챕cision n째 2026-"+n+" QPC du 11 octobre 2026",publishedAt:"2026-10-11T00:00:00.000Z",contentType:"decision",metadata:{collection:{strategy:"official-listing"}}});
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

test("ES published Core records missing the official decision date are prioritized for bounded recheck even inside the seven-day cooldown",async t=>{
  const f=fixture(t),sourceKey="es-tribunal-constitucional" as const;
  const url="https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/32151";
  const now=NOW;
  const original=f.core.rows("articles")[0];
  assert.ok(original);
  f.core.db.prepare("UPDATE articles SET source_key=?,canonical_url=?,original_published_at=NULL,fetched_at=?,lifecycle_collection_state='source_text_ready' WHERE id=?")
    .run(sourceKey,url,new Date(Date.parse(now)-60000).toISOString(),original.id);
  await enqueueIngestStageDiscovery(f.ingest,f.bucket,{sourceKey,now});
  const jobs=await claimIngestStageJobs(f.ingest,{stage:"discovery",workerId:"es-date-fixture",limit:1,leaseSeconds:300,now});
  assert.equal(jobs.length,1);
  const owner={jobId:jobs[0].id,fencingToken:jobs[0].claimed_fencing_token!,now};
  const candidateEs:NativeStageCandidate={sourceKey,url,title:"SENTENCIA 67/2026",publishedAt:"2026-10-06T00:00:00.000Z",contentType:"decision",metadata:{}};
  const snapshot=await captureDiscoverySnapshot(f.ingest,f.core,f.bucket,owner,{sourceKey,candidates:[candidateEs],recheckLimit:20,rangeDays:180});
  assert.equal(snapshot.items.length,1);
  assert.equal(snapshot.items[0].coveredExisting,false);
  assert.equal(snapshot.items[0].priority,30);
  assert.match(snapshot.items[0].sourceVersion,/:repair-date:2026-10-20$/);
});

test("ES scheduler bootstrap limit 1 does not restrict missing-date rechecks to one per day",async t=>{
  const f=fixture(t),sourceKey="es-tribunal-constitucional" as const,url="https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/32151";
  const original=f.core.rows("articles")[0];
  assert.ok(original);
  f.core.db.prepare("UPDATE articles SET source_key=?,canonical_url=?,original_published_at=NULL,fetched_at=?,lifecycle_collection_state='source_text_ready' WHERE id=?")
    .run(sourceKey,url,new Date(Date.parse(NOW)-60000).toISOString(),original.id);
  await enqueueIngestStageDiscovery(f.ingest,f.bucket,{sourceKey,limit:1,now:NOW});
  const [job]=await claimIngestStageJobs(f.ingest,{stage:"discovery",workerId:"es-repair-bootstrap",limit:1,leaseSeconds:300,now:NOW});
  assert.ok(job);
  const message=buildIngestStageQueueMessage({jobId:job.id,articleId:job.article_id,stage:job.stage,sourceVersion:job.source_version,contentHash:job.content_hash,fencingToken:job.claimed_fencing_token!,enqueuedAt:NOW});
  const context={env:{},coreDb:f.core,ingestDb:f.ingest,message,job,now:NOW} as IngestStageHandlerContext;
  const fetcher:typeof fetch=async input=>String(input).endsWith("robots.txt")?
    new Response("User-agent: *\nAllow: /\nCrawl-delay: 0"):
    new Response('<time>2026-10-06</time><a href="/HJ/es/Resolucion/Show/32151">SENTENCIA 67/2026</a>');
  const handlers=createIngestStageHandlers({crawlerBindings:f.bindings,rawBucket:f.bucket,fetch:fetcher,now:()=>NOW,
    e2e:{sources:[sourceKey],search:f.search,verification:{apiBaseUrl:"https://fixture.example/api",deploymentRef:"fixture:es-date"}}});
  assert.equal((await handlers.discovery!(context)).status,"succeeded");
  const snapshot=(await readDiscoverySnapshot(f.ingest,f.bucket,job.id))!;
  const match=snapshot.items.find(item=>item.url===url);
  assert.ok(match);
  assert.equal(match.coveredExisting,false,"the 1-item bootstrap must not hide a missing official date");
  assert.match(match.sourceVersion,/:repair-date:2026-10-20$/);
});

// The 11/21 ES discovery re-observes a decision whose crawl job was dead-lettered
// on 10/20 with `crawler.source_unavailable_transport`. The immutable crawl key
// is reused, so a naive reservation only flips the journal to `reserved` while
// the crawl row stays terminal. The ordinary reservation tick must recover that
// exact transient code once, in place, and audited.
async function deadLetterCapturedItem(f:Awaited<ReturnType<typeof fixture>>,item:Record<string,unknown>,code:string,now:string) {
  const registration=await registerIngestStageJob(f.ingest,{stage:"crawl",articleId:String(item.candidate_id),sourceKey:SOURCE,sourceVersion:String(item.source_version),contentHash:String(item.snapshot_hash),payloadRef:String(item.artifact_ref),priority:Number(item.priority),now});
  const [job]=await claimIngestStageJobs(f.ingest,{stage:"crawl",workerId:"dlq-fixture",limit:1,leaseSeconds:300,now});
  assert.ok(job);
  await failIngestStageJob(f.ingest,{jobId:job.id,fencingToken:job.claimed_fencing_token!,stage:"crawl",errorCode:code,retry:false,now});
  return {jobId:registration.job.id,articleId:registration.job.article_id};
}

test("M5 reservation recovers an exact transient dead-lettered crawl job in place instead of falsely reserving it",async t=>{
  const f=fixture(t),observed="2026-11-21T00:00:00.000Z",prior="2026-10-20T00:00:00.000Z",only={...candidate(1201),title:'Décision n° 2026-1201 QPC du 20 novembre 2026'};
  const fetcher:typeof fetch=async input=>{const url=String(input);if(url.endsWith("robots.txt"))return new Response("User-agent: *\nAllow: /\nCrawl-delay: 0");
    if(url.endsWith("les-decisions"))return new Response('<a href="'+only.url+'">'+only.title+'</a>');throw Error("unexpected fetch "+url);};
  const handlers=createIngestStageHandlers({crawlerBindings:f.bindings,rawBucket:f.bucket,fetch:fetcher,now:()=>observed,
    e2e:{sources:[SOURCE],search:f.search,verification:{apiBaseUrl:"https://fixture.example/api",deploymentRef:"fixture:discovery"}}});
  const context=await f.context(observed);
  assert.equal((await handlers.discovery!(context)).status,"succeeded");
  const item=f.ingest.rows("ingest_discovery_items_v1")[0];
  const dead=await deadLetterCapturedItem(f,item,"crawler.source_unavailable_transport",prior);
  assert.equal(f.ingest.rows("ingest_stage_jobs").find(x=>x.id===dead.jobId)?.status,"dead_letter");
  const health=await reserveDiscoveryCandidates(f.ingest,f.bucket,{sources:[SOURCE],now:observed,owner:"next-day-tick"});
  assert.equal(health.recovered,1);assert.equal(health.reserved,1);assert.equal(health.pendingCount,0);
  const job=f.ingest.rows("ingest_stage_jobs").find(x=>x.id===dead.jobId)!;
  assert.equal(job.status,"pending","the reused crawl job is reactivated, not left terminal");
  assert.equal(job.last_error_code,null);assert.ok(Number(job.max_attempts)>Number(job.attempt_count));
  const reserved=f.ingest.rows("ingest_discovery_items_v1")[0];
  assert.equal(reserved.status,"reserved");assert.equal(reserved.crawl_job_id,dead.jobId);
  const ledger=f.ingest.rows("ingest_stage_redrive_records");
  assert.equal(ledger.length,1);assert.equal(ledger[0].outcome,"redriven");assert.equal(ledger[0].job_id,dead.jobId);
});

test("M5 transient crawl recovery is limited to one automatic redrive per job",async t=>{
  const f=fixture(t),day2="2026-11-21T00:00:00.000Z",day3="2026-11-22T00:00:00.000Z",prior="2026-10-20T00:00:00.000Z",only={...candidate(1201),title:'Décision n° 2026-1201 QPC du 20 novembre 2026'};
  const fetcher:typeof fetch=async input=>{const url=String(input);if(url.endsWith("robots.txt"))return new Response("User-agent: *\nAllow: /\nCrawl-delay: 0");
    if(url.endsWith("les-decisions"))return new Response('<a href="'+only.url+'">'+only.title+'</a>');throw Error("unexpected fetch "+url);};
  let clock=day2;
  const handlers=createIngestStageHandlers({crawlerBindings:f.bindings,rawBucket:f.bucket,fetch:fetcher,now:()=>clock,
    e2e:{sources:[SOURCE],search:f.search,verification:{apiBaseUrl:"https://fixture.example/api",deploymentRef:"fixture:discovery"}}});
  const context=await f.context(day2);
  assert.equal((await handlers.discovery!(context)).status,"succeeded");
  assert.equal(await completeIngestStageJob(f.ingest,{jobId:context.job.id,fencingToken:context.job.claimed_fencing_token!,stage:"discovery",now:day2}),true);
  const dead=await deadLetterCapturedItem(f,f.ingest.rows("ingest_discovery_items_v1")[0],"crawler.source_unavailable_transport",prior);
  assert.equal((await reserveDiscoveryCandidates(f.ingest,f.bucket,{sources:[SOURCE],now:day2,owner:"tick-1"})).recovered,1);
  const [retry]=await claimIngestStageJobs(f.ingest,{stage:"crawl",workerId:"crawl-fixture",limit:1,leaseSeconds:300,now:day2});
  assert.ok(retry);assert.equal(retry.id,dead.jobId);
  await failIngestStageJob(f.ingest,{jobId:dead.jobId,fencingToken:retry.claimed_fencing_token!,stage:"crawl",errorCode:"crawler.source_unavailable_transport",retry:false,now:day2});
  assert.equal(f.ingest.rows("ingest_stage_jobs").find(x=>x.id===dead.jobId)?.status,"dead_letter");
  clock=day3;const next=await f.context(day3);
  assert.equal((await handlers.discovery!(next)).status,"succeeded");
  const health=await reserveDiscoveryCandidates(f.ingest,f.bucket,{sources:[SOURCE],now:day3,owner:"tick-2"});
  assert.equal(health.recovered,0,"the second rediscovery must not reset the attempt budget again");
  assert.equal(health.terminalLinked,1,"the exhausted job is linked and counted, not auto-recovered again");
  assert.equal(health.pendingCount,0,"a terminal linkage must not keep the scan pending forever");
  assert.equal(f.ingest.rows("ingest_stage_jobs").find(x=>x.id===dead.jobId)?.status,"dead_letter");
  assert.equal(f.ingest.rows("ingest_stage_redrive_records").length,1);
});

test("M5 terminal source, duplicate and human-review dead letters are linked without blocking normal candidates",async t=>{
  const f=fixture(t),observed="2026-11-21T00:00:00.000Z",prior="2026-10-20T00:00:00.000Z";
  const blocked={...candidate(1201),title:'Décision n° 2026-1201 QPC du 20 novembre 2026'},normal={...candidate(1202),title:'Décision n° 2026-1202 QPC du 20 novembre 2026'};
  const fetcher:typeof fetch=async input=>{const url=String(input);if(url.endsWith("robots.txt"))return new Response("User-agent: *\nAllow: /\nCrawl-delay: 0");
    if(url.endsWith("les-decisions"))return new Response([blocked,normal].map(c=>'<a href="'+c.url+'">'+c.title+'</a>').join("\n"));throw Error("unexpected fetch "+url);};
  const handlers=createIngestStageHandlers({crawlerBindings:f.bindings,rawBucket:f.bucket,fetch:fetcher,now:()=>observed,
    e2e:{sources:[SOURCE],search:f.search,verification:{apiBaseUrl:"https://fixture.example/api",deploymentRef:"fixture:discovery"}}});
  const context=await f.context(observed);
  assert.equal((await handlers.discovery!(context)).status,"succeeded");
  const blockedItem=f.ingest.rows("ingest_discovery_items_v1").find(x=>x.canonical_url===blocked.url)!;
  assert.ok(blockedItem);
  const dead=await deadLetterCapturedItem(f,blockedItem,"crawler.robots_disallowed",prior);
  const health=await reserveDiscoveryCandidates(f.ingest,f.bucket,{sources:[SOURCE],now:observed,owner:"terminal-tick"});
  assert.equal(health.recovered,0);assert.equal(health.terminalLinked,1);assert.equal(health.reserved,1,"the normal candidate is still reserved in the same tick");
  assert.equal(health.pendingCount,0);assert.equal(f.ingest.rows("ingest_discovery_scans_v1")[0].status,"reserved");
  assert.equal(f.ingest.rows("ingest_stage_jobs").find(x=>x.id===dead.jobId)?.status,"dead_letter");
  const linked=f.ingest.rows("ingest_discovery_items_v1").find(x=>x.canonical_url===blocked.url)!;
  assert.equal(linked.status,"reserved");assert.equal(linked.crawl_job_id,dead.jobId);
  assert.equal(f.ingest.rows("ingest_stage_redrive_records").length,0);
  const second=await reserveDiscoveryCandidates(f.ingest,f.bucket,{sources:[SOURCE],now:observed,owner:"terminal-tick-2"});
  assert.equal(second.claimed,0,"a completed scan is never re-leased, so it cannot monopolize the tick budget");
  for(const code of ["crawler.official_404_unresolved","crawler.robots_disallowed","crawler.non_official_host","human_approval.required","duplicate_official_case","crawler.crawl_failed","ingest_stage.lease_attempts_exhausted"])
    assert.equal(isTransientCrawlDeadLetter({status:"dead_letter",last_error_code:code}),false,code);
  for(const code of ["crawler.source_unavailable_transport","crawler.source_unavailable_503","crawler.http_429","crawler.http_503","crawler.transient"])
    assert.equal(isTransientCrawlDeadLetter({status:"dead_letter",last_error_code:code}),true,code);
  assert.equal(isTransientCrawlDeadLetter({status:"pending",last_error_code:"crawler.source_unavailable_transport"}),false);
});

test("M5 a rate-limited automatic crawl recovery is deferred, never terminalized",async t=>{
  const f=fixture(t),observed="2026-11-21T00:00:00.000Z",prior="2026-10-20T00:00:00.000Z",only={...candidate(1201),title:'Décision n° 2026-1201 QPC du 20 novembre 2026'};
  const fetcher:typeof fetch=async input=>{const url=String(input);if(url.endsWith("robots.txt"))return new Response("User-agent: *\nAllow: /\nCrawl-delay: 0");
    if(url.endsWith("les-decisions"))return new Response('<a href="'+only.url+'">'+only.title+'</a>');throw Error("unexpected fetch "+url);};
  const handlers=createIngestStageHandlers({crawlerBindings:f.bindings,rawBucket:f.bucket,fetch:fetcher,now:()=>observed,
    e2e:{sources:[SOURCE],search:f.search,verification:{apiBaseUrl:"https://fixture.example/api",deploymentRef:"fixture:discovery"}}});
  const context=await f.context(observed);
  assert.equal((await handlers.discovery!(context)).status,"succeeded");
  const dead=await deadLetterCapturedItem(f,f.ingest.rows("ingest_discovery_items_v1")[0],"crawler.source_unavailable_transport",prior);
  // The operator already spent the whole 10/hour automatic recovery budget.
  for(let index=0;index<10;index+=1)f.ingest.db.prepare("INSERT INTO ingest_stage_redrive_records(id,job_id,stage,operator_id,reason,outcome,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(`prior-${index}`,`other-job-${index}`,"crawl","discovery-reservation:transient-crawl","budget", "redriven",observed);
  const health=await reserveDiscoveryCandidates(f.ingest,f.bucket,{sources:[SOURCE],now:observed,owner:"rate-limited-tick"});
  assert.equal(health.recovered,0,"a rate-limited recovery must not count as recovered");
  assert.equal(health.deferredRateLimited,1);
  assert.equal(health.terminalLinked,0,"a rate-limited recovery must never be terminalized");
  assert.equal(health.pendingCount,1,"the discovery item stays durably pending for the next window");
  assert.equal(f.ingest.rows("ingest_stage_jobs").find(x=>x.id===dead.jobId)?.status,"dead_letter");
  assert.equal(f.ingest.rows("ingest_discovery_items_v1")[0].status,"pending");
  assert.equal(f.ingest.rows("ingest_stage_redrive_records").filter(x=>x.outcome==="redriven").length,10);
  assert.equal(f.ingest.rows("ingest_stage_redrive_records").filter(x=>x.outcome==="denied_rate_limited").length,1);
});

test("M5 a retryable downstream dead letter is resumed after a succeeded crawl",async t=>{
  const f=fixture(t),observed="2026-11-21T00:00:00.000Z",only={...candidate(1201),title:'Décision n° 2026-1201 QPC du 20 novembre 2026'};
  const fetcher:typeof fetch=async input=>{const url=String(input);if(url.endsWith("robots.txt"))return new Response("User-agent: *\nAllow: /\nCrawl-delay: 0");
    if(url.endsWith("les-decisions"))return new Response('<a href="'+only.url+'">'+only.title+'</a>');throw Error("unexpected fetch "+url);};
  const handlers=createIngestStageHandlers({crawlerBindings:f.bindings,rawBucket:f.bucket,fetch:fetcher,now:()=>observed,
    e2e:{sources:[SOURCE],search:f.search,verification:{apiBaseUrl:"https://fixture.example/api",deploymentRef:"fixture:discovery"}}});
  const context=await f.context(observed);
  assert.equal((await handlers.discovery!(context)).status,"succeeded");
  const item=f.ingest.rows("ingest_discovery_items_v1")[0];
  const crawl=await registerIngestStageJob(f.ingest,{stage:"crawl",articleId:String(item.candidate_id),sourceKey:SOURCE,sourceVersion:String(item.source_version),contentHash:String(item.snapshot_hash),payloadRef:String(item.artifact_ref),now:observed});
  const [crawlClaim]=await claimIngestStageJobs(f.ingest,{stage:"crawl",workerId:"downstream-fixture",limit:1,leaseSeconds:300,now:observed});
  assert.ok(crawlClaim);
  assert.equal(await completeIngestStageJob(f.ingest,{jobId:crawl.job.id,fencingToken:crawlClaim.claimed_fencing_token!,stage:"crawl",now:observed}),true);
  const normalize=await registerIngestStageJob(f.ingest,{stage:"normalize",articleId:String(item.candidate_id),sourceKey:SOURCE,sourceVersion:"crawl-v1",contentHash:"crawl-hash",now:observed});
  const [normalizeClaim]=await claimIngestStageJobs(f.ingest,{stage:"normalize",workerId:"downstream-fixture",limit:1,leaseSeconds:300,now:observed});
  assert.ok(normalizeClaim);
  await failIngestStageJob(f.ingest,{jobId:normalize.job.id,fencingToken:normalizeClaim.claimed_fencing_token!,stage:"normalize",errorCode:"ingest_stage.normalize_retry",retry:true,now:observed});
  // Exhaust the normalize budget into a dead letter with a recorded retryable flag.
  f.ingest.db.prepare("UPDATE ingest_stage_jobs SET status='dead_letter',attempt_count=max_attempts,last_error_code=?,last_failure_retryable=1,claimed_fencing_token=? WHERE id=?")
    .run("ingest_stage.normalize_retry","final",normalize.job.id);
  const health=await reserveDiscoveryCandidates(f.ingest,f.bucket,{sources:[SOURCE],now:observed,owner:"downstream-tick"});
  assert.equal(health.recoveredDownstream,1,"the retryable downstream dead letter resumes");
  assert.equal(health.terminalLinked,0);
  assert.equal(f.ingest.rows("ingest_stage_jobs").find(x=>x.id===normalize.job.id)?.status,"pending");
  assert.equal(f.ingest.rows("ingest_discovery_items_v1")[0].status,"reserved");
  assert.equal(f.ingest.rows("ingest_stage_redrive_records")[0].operator_id,"discovery-reservation:downstream-resume");
});

test("M5 a final 404 is rechecked with a bounded new crawl revision after the cooldown",async t=>{
  const f=fixture(t),observed="2026-11-21T00:00:00.000Z",prior="2026-10-20T00:00:00.000Z",only={...candidate(1201),title:'Décision n° 2026-1201 QPC du 20 novembre 2026'};
  const fetcher:typeof fetch=async input=>{const url=String(input);if(url.endsWith("robots.txt"))return new Response("User-agent: *\nAllow: /\nCrawl-delay: 0");
    if(url.endsWith("les-decisions"))return new Response('<a href="'+only.url+'">'+only.title+'</a>');throw Error("unexpected fetch "+url);};
  const handlers=createIngestStageHandlers({crawlerBindings:f.bindings,rawBucket:f.bucket,fetch:fetcher,now:()=>observed,
    e2e:{sources:[SOURCE],search:f.search,verification:{apiBaseUrl:"https://fixture.example/api",deploymentRef:"fixture:discovery"}}});
  const context=await f.context(observed);
  assert.equal((await handlers.discovery!(context)).status,"succeeded");
  const item=f.ingest.rows("ingest_discovery_items_v1")[0];
  const dead=await deadLetterCapturedItem(f,item,"crawler.official_404_unresolved",prior);
  const health=await reserveDiscoveryCandidates(f.ingest,f.bucket,{sources:[SOURCE],now:observed,owner:"recheck-tick"});
  assert.equal(health.recheckScheduled,1);
  assert.equal(health.terminalLinked,0);
  assert.equal(health.pendingCount,0);
  const current=f.ingest.rows("ingest_discovery_items_v1")[0];
  assert.equal(current.status,"reserved");
  assert.notEqual(current.crawl_job_id,dead.jobId,"the terminal row stays immutable; a new revision is attempted");
  const recheck=f.ingest.rows("ingest_stage_jobs").find(x=>x.id===current.crawl_job_id)!;
  assert.equal(recheck.status,"pending");
  assert.match(String(recheck.source_version),new RegExp(`:recheck:${observed.slice(0,10)}$`));
  assert.equal(f.ingest.rows("ingest_stage_jobs").find(x=>x.id===dead.jobId)?.status,"dead_letter");
});
