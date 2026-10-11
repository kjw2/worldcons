import {canonicalJson} from "@/lib/backfill/canonical-json";
import {sha256Canonical} from "../e2e/contracts";
import {e2eRows} from "../e2e/generation-state";
import type {D1RuntimeDatabase,D1RuntimePreparedStatement} from "../d1/runtime-binding";
import {registerIngestStageJob} from "./repository";
import type {NativeStageCandidate} from "../../../workers/async-pipeline/src/native-crawler";

export interface DiscoveryBucket {
  put(key:string,value:Uint8Array,options?:{httpMetadata?:{contentType?:string}}):Promise<unknown>;
  get(key:string):Promise<{arrayBuffer():Promise<ArrayBuffer>}|null>;
}
export interface DiscoveryOwner {jobId:string;fencingToken:string;now:string;clock?:()=>string;sourceKey?:string}
interface Item {
  candidateId:string;candidate:NativeStageCandidate;url:string;snapshotHash:string;artifactRef:string;sourceVersion:string;priority:number;
  existingArticleId:string|null;coveredExisting:boolean;
}
export interface DiscoverySnapshot {
  schema:"worldcons.discovery-snapshot.v1";jobId:string;sourceKey:string;observedAt:string;
  scope:{rangeDays:number;countryCorpusComplete:false;window:string};items:Item[];
}
async function json(bucket:DiscoveryBucket,key:string) {
  const object=await bucket.get(key);if(!object)throw Error("discovery.snapshot_missing");
  return JSON.parse(new TextDecoder().decode(await object.arrayBuffer()));
}
async function batch(db:D1RuntimeDatabase,statements:D1RuntimePreparedStatement[]) {
  if(!db.batch)throw Error("discovery.batch_unavailable");
  const results=await db.batch(statements);
  if(results.length!==statements.length||results.some(x=>x.success===false||x.error))throw Error("discovery.batch_failed");
}
function parentGuard(db:D1RuntimeDatabase,owner:DiscoveryOwner,token:string) {
  return db.prepare("INSERT INTO ingest_discovery_commit_guards_v1(token,assertion) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM ingest_stage_jobs WHERE id=? AND stage='discovery' AND status='leased' AND claimed_fencing_token=? AND source_key=? AND lease_expires_at>?) THEN 1 ELSE 0 END)")
    .bind(token,owner.jobId,owner.fencingToken,owner.sourceKey,owner.clock?.()??owner.now);
}
function cleanup(db:D1RuntimeDatabase,token:string) {return db.prepare("DELETE FROM ingest_discovery_commit_guards_v1 WHERE token=?").bind(token);}
export async function readDiscoverySnapshot(db:D1RuntimeDatabase,bucket:DiscoveryBucket,jobId:string):Promise<DiscoverySnapshot|null> {
  const scan=(await e2eRows(db,"SELECT * FROM ingest_discovery_scans_v1 WHERE job_id=?",jobId))[0];
  if(!scan)return null;
  const snapshot=await json(bucket,String(scan.manifest_ref)) as DiscoverySnapshot;
  if(await sha256Canonical(snapshot)!==scan.manifest_hash||snapshot.schema!=="worldcons.discovery-snapshot.v1"
    ||snapshot.jobId!==jobId||snapshot.sourceKey!==scan.source_key||snapshot.items.length!==Number(scan.observed_count))throw Error("discovery.snapshot_mismatch");
  return snapshot;
}
/** Persist ALL observed candidates before the parent job can succeed. Replays use the pinned first snapshot. */
export async function captureDiscoverySnapshot(db:D1RuntimeDatabase,core:D1RuntimeDatabase,bucket:DiscoveryBucket,owner:DiscoveryOwner,
  input:{sourceKey:string;candidates:NativeStageCandidate[];recheckLimit:number;rangeDays:number}):Promise<DiscoverySnapshot> {
  owner={...owner,sourceKey:input.sourceKey};
  let snapshot=await readDiscoverySnapshot(db,bucket,owner.jobId);
  if(snapshot&&snapshot.sourceKey!==input.sourceKey)throw Error("discovery.parent_source_mismatch");
  if(!snapshot) {
    const candidates=[...new Map(input.candidates.map(c=>[c.url,c])).values()];
    const known=new Map<string,Record<string,unknown>>(),latest=new Map<string,Record<string,unknown>>();
    const identified=await Promise.all(candidates.map(async candidate=>({candidate,id:"native:"+(await sha256CanonicalUrl(candidate.sourceKey,candidate.url)).slice(0,32)})));
    for(let offset=0;offset<identified.length;offset+=80) {
      const chunk=identified.slice(offset,offset+80),marks=chunk.map(()=>"?").join(",");
      for(const row of await e2eRows(core,"SELECT id,source_key,canonical_url,fetched_at,lifecycle_collection_state FROM articles WHERE canonical_url IN ("+marks+")",...chunk.map(x=>x.candidate.url)))known.set(String(row.canonical_url),row);
      const jobs=await e2eRows(db,"SELECT j.* FROM ingest_stage_jobs j WHERE j.stage='crawl' AND j.article_id IN ("+marks+") AND NOT EXISTS(SELECT 1 FROM ingest_stage_jobs newer WHERE newer.article_id=j.article_id AND newer.stage='crawl' AND (newer.created_at>j.created_at OR (newer.created_at=j.created_at AND newer.id>j.id)))",...chunk.map(x=>x.id));
      for(const row of jobs)latest.set(String(row.article_id),row);
    }
    const due=identified.filter(x=>{
      const article=known.get(x.candidate.url),job=latest.get(x.id);
      return article?.source_key===input.sourceKey&&article.lifecycle_collection_state==="source_text_ready"
        &&(!job||job.status==="succeeded")&&Date.parse(String(job?.completed_at??article.fetched_at??"1970-01-01"))<Date.parse(owner.now)-7*86400000;
    }).sort((a,b)=>String(latest.get(a.id)?.completed_at??known.get(a.candidate.url)?.fetched_at??"").localeCompare(String(latest.get(b.id)?.completed_at??known.get(b.candidate.url)?.fetched_at??""))||a.id.localeCompare(b.id));
    const rechecks=new Set(due.slice(0,Math.max(0,Math.min(input.recheckLimit,20))).map(x=>x.id));
    const items:Item[]=[];
    for(const {candidate,id} of identified) {
      const snapshotHash=await sha256Canonical(candidate),artifactRef="stages/ingest-discovery/"+input.sourceKey+"/"+snapshotHash+".json";
      const article=known.get(candidate.url),knownReady=article?.source_key===input.sourceKey&&article.lifecycle_collection_state==="source_text_ready";
      items.push({candidateId:id,candidate,url:candidate.url,snapshotHash,artifactRef,existingArticleId:article?.source_key===input.sourceKey?String(article.id):null,
        coveredExisting:Boolean(knownReady)&&!rechecks.has(id),priority:article?0:50,
        sourceVersion:"discovery-snapshot-v1:"+snapshotHash+(rechecks.has(id)?":recheck:"+owner.now.slice(0,10):"")});
    }
    const proposed:DiscoverySnapshot={schema:"worldcons.discovery-snapshot.v1",jobId:owner.jobId,sourceKey:input.sourceKey,observedAt:owner.now,
      scope:{rangeDays:input.rangeDays,countryCorpusComplete:false,window:"official listing; ES search at most four pages per type/year or bounded HJ tail; observed window only"},items};
    const hash=await sha256Canonical(proposed),ref="stages/ingest-discovery-snapshot/"+input.sourceKey+"/"+hash+".json";
    await bucket.put(ref,new TextEncoder().encode(canonicalJson(proposed)),{httpMetadata:{contentType:"application/json"}});
    const token=crypto.randomUUID();
    await batch(db,[parentGuard(db,owner,token),db.prepare("INSERT INTO ingest_discovery_scans_v1(job_id,source_key,manifest_ref,manifest_hash,observed_count,status,captured_at,updated_at) VALUES (?,?,?,?,?,'capturing',?,?) ON CONFLICT(job_id) DO NOTHING")
      .bind(owner.jobId,input.sourceKey,ref,hash,items.length,owner.now,owner.now),cleanup(db,token)]);
    snapshot=(await readDiscoverySnapshot(db,bucket,owner.jobId))!;
  }
  for(let offset=0;offset<snapshot.items.length;offset+=40) {
    const token=crypto.randomUUID(),statements=[parentGuard(db,owner,token)];
    for(const item of snapshot.items.slice(offset,offset+40))statements.push(db.prepare("INSERT INTO ingest_discovery_items_v1(job_id,candidate_id,snapshot_hash,canonical_url,artifact_ref,source_version,priority,status,existing_article_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,candidate_id) DO NOTHING")
      .bind(owner.jobId,item.candidateId,item.snapshotHash,item.url,item.artifactRef,item.sourceVersion,item.priority,item.coveredExisting?"covered_existing":"pending",item.existingArticleId,owner.now));
    statements.push(cleanup(db,token));await batch(db,statements);
  }
  const token=crypto.randomUUID();
  await batch(db,[parentGuard(db,owner,token),db.prepare("INSERT INTO ingest_discovery_commit_guards_v1(token,assertion) VALUES (?,CASE WHEN (SELECT COUNT(*) FROM ingest_discovery_items_v1 WHERE job_id=?)=? THEN 1 ELSE 0 END)").bind(token+":count",owner.jobId,snapshot.items.length),
    db.prepare("UPDATE ingest_discovery_scans_v1 SET status=CASE WHEN status='capturing' THEN 'pending' ELSE status END,updated_at=? WHERE job_id=?").bind(owner.now,owner.jobId),cleanup(db,token+":count"),cleanup(db,token)]);
  return snapshot;
}
// Same identity bytes as nativeStageCandidateId, retained separately to keep this runtime module free of crawler imports.
async function sha256CanonicalUrl(source:string,url:string) {
  const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(source+"\u001f"+url)));
  return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("");
}
/** Reservation owner resumes captured candidates independently of Queue delivery and parent completion. */
export async function reserveDiscoveryCandidates(db:D1RuntimeDatabase,bucket:DiscoveryBucket,input:{now:string;owner:string;limit?:number;sources:readonly string[];clock?:()=>string}) {
  const limit=Math.max(1,Math.min(input.limit??20,40));
  if(!input.sources.length)throw Error("discovery.sources_empty");
  const scans=await e2eRows(db,"SELECT * FROM ingest_discovery_scans_v1 WHERE source_key IN ("+input.sources.map(()=>"?").join(",")+") AND (status='pending' OR (status='leased' AND lease_expires_at<=?)) ORDER BY captured_at,job_id LIMIT 10",...input.sources,input.now);
  let reserved=0,claimed=0;
  for(const scan of scans.filter(x=>input.sources.includes(String(x.source_key)))) {
    const leaseUntil=new Date(Date.parse(input.now)+300000).toISOString(),owner=input.owner+":"+crypto.randomUUID();
    const result=await db.prepare("UPDATE ingest_discovery_scans_v1 SET status='leased',reservation_fence=reservation_fence+1,reservation_owner=?,lease_expires_at=?,updated_at=? WHERE job_id=? AND (status='pending' OR (status='leased' AND lease_expires_at<=?))")
      .bind(owner,leaseUntil,input.now,scan.job_id,input.now).run?.();
    if(!result||result.success===false||result.error)throw Error("discovery.claim_failed");
    if(Number(result.meta?.changes)!==1)continue;claimed++;
    const current=(await e2eRows(db,"SELECT * FROM ingest_discovery_scans_v1 WHERE job_id=?",scan.job_id))[0],fence=Number(current.reservation_fence);
    const snapshot=(await readDiscoverySnapshot(db,bucket,String(scan.job_id)))!;
    const items=await e2eRows(db,"SELECT * FROM ingest_discovery_items_v1 WHERE job_id=? AND status='pending' ORDER BY priority DESC,candidate_id LIMIT ?",scan.job_id,limit-reserved);
    const guard=(token:string)=>db.prepare("INSERT INTO ingest_discovery_commit_guards_v1(token,assertion) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM ingest_discovery_scans_v1 WHERE job_id=? AND status='leased' AND reservation_owner=? AND reservation_fence=? AND lease_expires_at>?) THEN 1 ELSE 0 END)").bind(token,scan.job_id,owner,fence,input.clock?.()??input.now);
    for(const item of items) {
      const pinned=snapshot.items.find(x=>x.candidateId===item.candidate_id);
      const candidate=pinned?.candidate;
      if(!pinned||await sha256Canonical(candidate)!==item.snapshot_hash||pinned.snapshotHash!==item.snapshot_hash||pinned.sourceVersion!==item.source_version||pinned.artifactRef!==item.artifact_ref)throw Error("discovery.candidate_mismatch");
      await bucket.put(String(item.artifact_ref),new TextEncoder().encode(canonicalJson(candidate)),{httpMetadata:{contentType:"application/json"}});
      const registration=await registerIngestStageJob(db,{stage:"crawl",articleId:String(item.candidate_id),sourceKey:String(scan.source_key),sourceVersion:String(item.source_version),contentHash:String(item.snapshot_hash),payloadRef:String(item.artifact_ref),priority:Number(item.priority),now:input.now});
      const token=crypto.randomUUID();
      await batch(db,[guard(token),db.prepare("UPDATE ingest_discovery_items_v1 SET status='reserved',crawl_job_id=?,updated_at=? WHERE job_id=? AND candidate_id=? AND status='pending'").bind(registration.job.id,input.now,scan.job_id,item.candidate_id),cleanup(db,token)]);reserved++;
    }
    const token=crypto.randomUUID();
    await batch(db,[guard(token),db.prepare("UPDATE ingest_discovery_scans_v1 SET status=CASE WHEN EXISTS(SELECT 1 FROM ingest_discovery_items_v1 WHERE job_id=? AND status='pending') THEN 'pending' ELSE 'reserved' END,reservation_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=?")
      .bind(scan.job_id,input.now,scan.job_id),cleanup(db,token)]);
    if(reserved>=limit)break;
  }
  const pending=(await e2eRows(db,"SELECT COUNT(*) AS count,MIN(s.captured_at) AS oldest FROM ingest_discovery_items_v1 i JOIN ingest_discovery_scans_v1 s ON s.job_id=i.job_id WHERE i.status='pending'"))[0];
  const pendingCount=Number(pending.count),oldestPendingAgeSeconds=pending.oldest?Math.max(0,(Date.parse(input.now)-Date.parse(String(pending.oldest)))/1000):0;
  const stalled=(await e2eRows(db,"SELECT COUNT(*) AS count FROM ingest_discovery_scans_v1 WHERE status='capturing' AND captured_at<=?",new Date(Date.parse(input.now)-1800000).toISOString()))[0];
  const stalledCaptureCount=Number(stalled.count);
  return {claimed,reserved,pendingCount,oldestPendingAgeSeconds,stalledCaptureCount,requiresAttention:stalledCaptureCount>0||(pendingCount>0&&oldestPendingAgeSeconds>1800)};
}
