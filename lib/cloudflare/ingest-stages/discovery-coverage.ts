import {canonicalOfficialArticleUrl} from "../../search/official-case-url";
import {canonicalJson} from "@/lib/backfill/canonical-json";
import {sha256Canonical} from "../e2e/contracts";
import {e2eRows} from "../e2e/generation-state";
import type {D1RuntimeDatabase,D1RuntimePreparedStatement} from "../d1/runtime-binding";
import {registerIngestStageJob,type IngestStageJobRow} from "./repository";
import {redriveIngestStageDeadLetter} from "./redrive";
import {INGEST_STAGE_MAX_ATTEMPTS} from "./contracts";
import type {NativeStageCandidate} from "../../../workers/async-pipeline/src/native-crawler";

/**
 * Crawl error codes the crawler records as *recoverable* transport/pacing
 * failures. Only these exact, stable codes are eligible for the reservation
 * tick's automatic recovery; the broad `crawler.crawl_failed` fallback and any
 * free-form summary are deliberately excluded. Official 404/410, robots,
 * non-official host, invalid identity/payload, duplicate-official-case, policy
 * and human-review outcomes stay fail-closed for an operator.
 */
const TRANSIENT_CRAWL_ERROR_CODES: ReadonlySet<string> = new Set([
  "crawler.transient",
  "crawler.http_429",
  "crawler.source_unavailable_transport",
  "crawler.source_unavailable_429",
]);
const TRANSIENT_CRAWL_ERROR_PATTERN = /^crawler\.(?:http_5\d\d|source_unavailable_5\d\d)$/;
/** One automated transient recovery per crawl job; later failures need an operator. */
const MAX_AUTOMATED_CRAWL_RECOVERIES = 1;
const AUTOMATED_RECOVERY_OPERATOR = "discovery-reservation:transient-crawl";

/** True only for a dead-letter crawl job whose recorded failure is provably transient. */
export function isTransientCrawlDeadLetter(job: Pick<IngestStageJobRow,"status"|"last_error_code">): boolean {
  if(job.status!=="dead_letter")return false;
  const code=job.last_error_code??"";
  return TRANSIENT_CRAWL_ERROR_CODES.has(code)||TRANSIENT_CRAWL_ERROR_PATTERN.test(code);
}

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
    const candidates=[...new Map(input.candidates.map(c=>({...c,url:canonicalOfficialArticleUrl(c.sourceKey,c.url)})).map(c=>[c.url,c])).values()];
    const known=new Map<string,Record<string,unknown>>(),latest=new Map<string,Record<string,unknown>>();
    const identified=await Promise.all(candidates.map(async candidate=>({candidate,id:"native:"+(await sha256CanonicalUrl(candidate.sourceKey,candidate.url)).slice(0,32)})));
    for(let offset=0;offset<identified.length;offset+=40) {
      const chunk=identified.slice(offset,offset+40),marks=chunk.map(()=>"?").join(",");
      const aliases=[...new Set(chunk.flatMap(x=>[x.candidate.url,x.candidate.sourceKey==="es-tribunal-constitucional"?x.candidate.url.replace("/HJ/es/","/es/"):x.candidate.url]))];
      for(const row of await e2eRows(core,`SELECT a.id,a.source_key,a.canonical_url,a.fetched_at,a.lifecycle_collection_state,a.original_published_at,
        p.version_id AS published_version_id,v.original_published_at AS published_version_date
        FROM articles a LEFT JOIN article_publications_p3 p ON p.article_id=a.id AND p.state='published'
        LEFT JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=a.id
        WHERE a.canonical_url IN (`+aliases.map(()=>"?").join(",")+`) ORDER BY a.created_at DESC,a.id DESC`,...aliases))known.set(canonicalOfficialArticleUrl(String(row.source_key),String(row.canonical_url)),row);
      const jobs=await e2eRows(db,"SELECT j.* FROM ingest_stage_jobs j WHERE j.stage='crawl' AND j.article_id IN ("+marks+") AND NOT EXISTS(SELECT 1 FROM ingest_stage_jobs newer WHERE newer.article_id=j.article_id AND newer.stage='crawl' AND (newer.created_at>j.created_at OR (newer.created_at=j.created_at AND newer.id>j.id)))",...chunk.map(x=>x.id));
      for(const row of jobs)latest.set(String(row.article_id),row);
    }
    const needsSpainDateRecovery=(article:Record<string,unknown>|undefined)=>Boolean(article&&input.sourceKey==="es-tribunal-constitucional"
      &&(article.original_published_at==null||(article.published_version_id!=null&&article.published_version_date==null)));
    const due=identified.filter(x=>{
      const article=known.get(x.candidate.url),job=latest.get(x.id);
      return article?.source_key===input.sourceKey&&article.lifecycle_collection_state==="source_text_ready"
        &&(!job||job.status==="succeeded")&&(needsSpainDateRecovery(article)
          ||Date.parse(String(job?.completed_at??article.fetched_at??"1970-01-01"))<Date.parse(owner.now)-7*86400000);
    }).sort((a,b)=>Number(needsSpainDateRecovery(known.get(b.candidate.url)))-Number(needsSpainDateRecovery(known.get(a.candidate.url)))
      ||String(latest.get(a.id)?.completed_at??known.get(a.candidate.url)?.fetched_at??"").localeCompare(String(latest.get(b.id)?.completed_at??known.get(b.candidate.url)?.fetched_at??""))
      ||a.id.localeCompare(b.id));
    const rechecks=new Set(due.slice(0,Math.max(0,Math.min(input.recheckLimit,20))).map(x=>x.id));
    const items:Item[]=[];
    for(const {candidate,id} of identified) {
      const snapshotHash=await sha256Canonical(candidate),artifactRef="stages/ingest-discovery/"+input.sourceKey+"/"+snapshotHash+".json";
      const article=known.get(candidate.url),knownReady=article?.source_key===input.sourceKey&&article.lifecycle_collection_state==="source_text_ready";
      items.push({candidateId:id,candidate,url:candidate.url,snapshotHash,artifactRef,existingArticleId:article?.source_key===input.sourceKey?String(article.id):null,
        coveredExisting:Boolean(knownReady)&&!rechecks.has(id),priority:article?(rechecks.has(id)&&needsSpainDateRecovery(article)?30:0):50,
        sourceVersion:"discovery-snapshot-v1:"+snapshotHash+(rechecks.has(id)?(needsSpainDateRecovery(article)?":repair-date:":":recheck:")+owner.now.slice(0,10):"")});
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
  let reserved=0,claimed=0,recovered=0,terminalLinked=0,handled=0;
  for(const scan of scans.filter(x=>input.sources.includes(String(x.source_key)))) {
    const leaseUntil=new Date(Date.parse(input.now)+300000).toISOString(),owner=input.owner+":"+crypto.randomUUID();
    const result=await db.prepare("UPDATE ingest_discovery_scans_v1 SET status='leased',reservation_fence=reservation_fence+1,reservation_owner=?,lease_expires_at=?,updated_at=? WHERE job_id=? AND (status='pending' OR (status='leased' AND lease_expires_at<=?))")
      .bind(owner,leaseUntil,input.now,scan.job_id,input.now).run?.();
    if(!result||result.success===false||result.error)throw Error("discovery.claim_failed");
    if(Number(result.meta?.changes)!==1)continue;claimed++;
    const current=(await e2eRows(db,"SELECT * FROM ingest_discovery_scans_v1 WHERE job_id=?",scan.job_id))[0],fence=Number(current.reservation_fence);
    const snapshot=(await readDiscoverySnapshot(db,bucket,String(scan.job_id)))!;
    const items=await e2eRows(db,"SELECT * FROM ingest_discovery_items_v1 WHERE job_id=? AND status='pending' ORDER BY priority DESC,candidate_id LIMIT ?",scan.job_id,limit-handled);
    const guard=(token:string)=>db.prepare("INSERT INTO ingest_discovery_commit_guards_v1(token,assertion) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM ingest_discovery_scans_v1 WHERE job_id=? AND status='leased' AND reservation_owner=? AND reservation_fence=? AND lease_expires_at>?) THEN 1 ELSE 0 END)").bind(token,scan.job_id,owner,fence,input.clock?.()??input.now);
    for(const item of items) {
      const pinned=snapshot.items.find(x=>x.candidateId===item.candidate_id);
      const candidate=pinned?.candidate;
      if(!pinned||await sha256Canonical(candidate)!==item.snapshot_hash||pinned.snapshotHash!==item.snapshot_hash||pinned.sourceVersion!==item.source_version||pinned.artifactRef!==item.artifact_ref)throw Error("discovery.candidate_mismatch");
      await bucket.put(String(item.artifact_ref),new TextEncoder().encode(canonicalJson(candidate)),{httpMetadata:{contentType:"application/json"}});
      const registration=await registerIngestStageJob(db,{stage:"crawl",articleId:String(item.candidate_id),sourceKey:String(scan.source_key),sourceVersion:String(item.source_version),contentHash:String(item.snapshot_hash),payloadRef:String(item.artifact_ref),priority:Number(item.priority),now:input.now});
      // The crawl idempotency key is pinned to the candidate snapshot, so a new
      // discovery day re-uses a *previous* dead-letter job for the same candidate
      // instead of doing any crawl work. Only a transiently failed job may be
      // recovered once, in place, on this ordinary path. Terminal source/policy,
      // duplicate and human-review outcomes are linked to their existing job and
      // counted separately, so they neither block nor masquerade as new work.
      let crawlJob=registration.job,live=true;
      if(crawlJob.status==="dead_letter") {
        live=false;
        // `max_attempts > INGEST_STAGE_MAX_ATTEMPTS` proves the row was already
        // redriven (redrive extends the budget). This holds even if the audit
        // ledger write failed, so an audit failure or a racing tick can never
        // reset the single automated-recovery budget.
        if(isTransientCrawlDeadLetter(crawlJob)&&crawlJob.max_attempts<=INGEST_STAGE_MAX_ATTEMPTS) {
          const prior=await e2eRows(db,"SELECT COUNT(*) AS count FROM ingest_stage_redrive_records WHERE job_id=? AND operator_id=? AND outcome='redriven'",crawlJob.id,AUTOMATED_RECOVERY_OPERATOR);
          if(Number(prior[0]?.count??0)<MAX_AUTOMATED_CRAWL_RECOVERIES) {
            const recovery=await redriveIngestStageDeadLetter(db,{stage:"crawl",jobId:crawlJob.id,operatorId:AUTOMATED_RECOVERY_OPERATOR,reason:"transient-crawl-recovery:"+(crawlJob.last_error_code??"unknown"),expectedFencingToken:crawlJob.claimed_fencing_token??null,now:input.now});
            if(recovery.outcome==="redriven") {crawlJob={...crawlJob,status:"pending",last_error_code:null,last_error_summary:null};live=true;recovered++;}
          }
        }
        if(!live)terminalLinked++;
      }
      const token=crypto.randomUUID();
      await batch(db,[guard(token),db.prepare("UPDATE ingest_discovery_items_v1 SET status='reserved',crawl_job_id=?,updated_at=? WHERE job_id=? AND candidate_id=? AND status='pending'").bind(crawlJob.id,input.now,scan.job_id,item.candidate_id),cleanup(db,token)]);
      if(live)reserved++;
      handled++;
    }
    const token=crypto.randomUUID();
    await batch(db,[guard(token),db.prepare("UPDATE ingest_discovery_scans_v1 SET status=CASE WHEN EXISTS(SELECT 1 FROM ingest_discovery_items_v1 WHERE job_id=? AND status='pending') THEN 'pending' ELSE 'reserved' END,reservation_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=?")
      .bind(scan.job_id,input.now,scan.job_id),cleanup(db,token)]);
    if(handled>=limit)break;
  }
  const pending=(await e2eRows(db,"SELECT COUNT(*) AS count,MIN(s.captured_at) AS oldest FROM ingest_discovery_items_v1 i JOIN ingest_discovery_scans_v1 s ON s.job_id=i.job_id WHERE i.status='pending'"))[0];
  const pendingCount=Number(pending.count),oldestPendingAgeSeconds=pending.oldest?Math.max(0,(Date.parse(input.now)-Date.parse(String(pending.oldest)))/1000):0;
  const stalled=(await e2eRows(db,"SELECT COUNT(*) AS count FROM ingest_discovery_scans_v1 WHERE status='capturing' AND captured_at<=?",new Date(Date.parse(input.now)-1800000).toISOString()))[0];
  const stalledCaptureCount=Number(stalled.count);
  return {claimed,reserved,recovered,terminalLinked,pendingCount,oldestPendingAgeSeconds,stalledCaptureCount,requiresAttention:stalledCaptureCount>0||(pendingCount>0&&oldestPendingAgeSeconds>1800)};
}

