import {canonicalOfficialArticleUrl} from "../../search/official-case-url";
import {canonicalJson} from "@/lib/backfill/canonical-json";
import {sha256Canonical} from "../e2e/contracts";
import {e2eRows} from "../e2e/generation-state";
import type {D1RuntimeDatabase,D1RuntimePreparedStatement} from "../d1/runtime-binding";
import {registerIngestStageJob,type IngestStageJobRow} from "./repository";
import {redriveIngestStageDeadLetter} from "./redrive";
import {isRetryableStageDeadLetter} from "./retry-policy";
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
/** One automated downstream resume per dead-letter job; later failures need an operator. */
const MAX_AUTOMATED_DOWNSTREAM_RECOVERIES = 1;
const AUTOMATED_DOWNSTREAM_OPERATOR = "discovery-reservation:downstream-resume";
/**
 * A final official 404/410 is not retried automatically, but the same candidate
 * is rechecked at most once per cooldown window so a page that is published
 * later can still be collected without an operator. The recheck budget is a
 * finite year of weekly attempts; after that the item stays linked to its
 * terminal job for explicit review.
 */
const TERMINAL_RECHECK_COOLDOWN_MS = 7 * 86_400_000;
const MAX_TERMINAL_RECHECKS = 52;
const TERMINAL_RECHECK_ERROR_CODE = "crawler.official_404_unresolved";

type AutomatedRedriveOutcome = "recovered" | "deferred_rate_limited" | "deferred_ledger" | "deferred_racing" | "terminal";

async function priorAutomatedRedrives(db:D1RuntimeDatabase,jobId:string,operator:string):Promise<number|null> {
  try {
    const rows=await e2eRows(db,"SELECT COUNT(*) AS count FROM ingest_stage_redrive_records WHERE job_id=? AND operator_id=? AND outcome='redriven'",jobId,operator);
    return Number(rows[0]?.count??0);
  } catch {
    // The redrive ledger migration is mandatory, but a missing table must not
    // livelock the minute tick. The caller defers the item and reports attention.
    return null;
  }
}

async function attemptAutomatedRedrive(
  db:D1RuntimeDatabase,
  input:{job:IngestStageJobRow;stage:IngestStageJobRow["stage"];operator:string;reason:string;now:string},
):Promise<AutomatedRedriveOutcome> {
  try {
    const result=await redriveIngestStageDeadLetter(db,{stage:input.stage,jobId:input.job.id,operatorId:input.operator,reason:input.reason,
      expectedFencingToken:input.job.claimed_fencing_token??null,now:input.now});
    if(result.outcome==="redriven")return "recovered";
    if(result.outcome==="denied_rate_limited")return "deferred_rate_limited";
    if(result.outcome==="denied_nonterminal"||result.outcome==="denied_fencing_mismatch")return "deferred_racing";
    return "terminal";
  } catch {
    return "deferred_ledger";
  }
}

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
    const known=new Map<string,Record<string,unknown>>(),latest=new Map<string,Record<string,unknown>>(),downstreamDead=new Map<string,IngestStageJobRow>();
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
      const downstream=await e2eRows(db,"SELECT * FROM ingest_stage_jobs WHERE stage<>'crawl' AND status='dead_letter' AND article_id IN ("+marks+") ORDER BY created_at,id",...chunk.map(x=>x.id));
      for(const row of downstream)if(!downstreamDead.has(String(row.article_id)))downstreamDead.set(String(row.article_id),row as unknown as IngestStageJobRow);
    }
    const needsSpainDateRecovery=(article:Record<string,unknown>|undefined)=>Boolean(article&&input.sourceKey==="es-tribunal-constitucional"
      &&(article.original_published_at==null||(article.published_version_id!=null&&article.published_version_date==null)));
    // A crawl that succeeded but whose next stage dead-lettered on a transient
    // error must be resumed on re-observation. Without this, the pinned crawl
    // idempotency key reuses the already-succeeded crawl job and the downstream
    // dead letter is never executed again.
    const needsDownstreamResume=(id:string)=>isRetryableStageDeadLetter(downstreamDead.get(id)??{stage:"crawl",status:"dead_letter",last_error_code:null,last_failure_retryable:null});
    const due=identified.filter(x=>{
      const article=known.get(x.candidate.url),job=latest.get(x.id);
      return article?.source_key===input.sourceKey&&article.lifecycle_collection_state==="source_text_ready"
        &&(!job||job.status==="succeeded")&&(needsSpainDateRecovery(article)||needsDownstreamResume(x.id)
          ||Date.parse(String(job?.completed_at??article.fetched_at??"1970-01-01"))<Date.parse(owner.now)-7*86400000);
    }).sort((a,b)=>Number(needsSpainDateRecovery(known.get(b.candidate.url)))-Number(needsSpainDateRecovery(known.get(a.candidate.url)))
      ||Number(needsDownstreamResume(b.id))-Number(needsDownstreamResume(a.id))
      ||String(latest.get(a.id)?.completed_at??known.get(a.candidate.url)?.fetched_at??"").localeCompare(String(latest.get(b.id)?.completed_at??known.get(b.candidate.url)?.fetched_at??""))
      ||a.id.localeCompare(b.id));
    const rechecks=new Set(due.slice(0,Math.max(0,Math.min(input.recheckLimit,20))).map(x=>x.id));
    const downstreamResume=new Set(due.filter(x=>needsDownstreamResume(x.id)&&!needsSpainDateRecovery(known.get(x.candidate.url))).slice(0,Math.max(0,Math.min(input.recheckLimit,20))).map(x=>x.id));
    const items:Item[]=[];
    for(const {candidate,id} of identified) {
      const snapshotHash=await sha256Canonical(candidate),artifactRef="stages/ingest-discovery/"+input.sourceKey+"/"+snapshotHash+".json";
      const article=known.get(candidate.url),knownReady=article?.source_key===input.sourceKey&&article.lifecycle_collection_state==="source_text_ready";
      // A downstream resume reuses the already-succeeded crawl job (base
      // sourceVersion, no suffix) and redrives the dead downstream stage. Date
      // repair and the ordinary 7-day recheck deliberately create a fresh crawl
      // revision so source text is re-observed.
      const resume=downstreamResume.has(id);
      const marker=resume?"":needsSpainDateRecovery(article)?":repair-date:":":recheck:";
      items.push({candidateId:id,candidate,url:candidate.url,snapshotHash,artifactRef,existingArticleId:article?.source_key===input.sourceKey?String(article.id):null,
        coveredExisting:Boolean(knownReady)&&!rechecks.has(id),priority:article?(needsSpainDateRecovery(article)?30:resume?20:0):50,
        sourceVersion:"discovery-snapshot-v1:"+snapshotHash+(rechecks.has(id)&&marker?marker+owner.now.slice(0,10):"")});
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
  let reserved=0,claimed=0,recovered=0,recoveredDownstream=0,terminalLinked=0,handled=0;
  let deferredRateLimited=0,deferredLedgerUnavailable=0,recheckScheduled=0,recheckExhausted=0,deferred=false;
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
      // The base crawl idempotency key is pinned to the candidate snapshot. A
      // newer recheck revision may already exist, so all decisions use the
      // newest row for the article, never merely the pinned registration.
      const newest=await e2eRows(db,"SELECT * FROM ingest_stage_jobs WHERE stage='crawl' AND article_id=? ORDER BY created_at DESC,id DESC LIMIT 1",String(item.candidate_id));
      let crawlJob=(newest[0] as unknown as IngestStageJobRow|undefined)??registration.job,live=true,defer=false;
      if(crawlJob.status==="dead_letter") {
        live=false;
        // `max_attempts > INGEST_STAGE_MAX_ATTEMPTS` proves the row was already
        // redriven (redrive extends the budget). This holds even if the audit
        // ledger write failed, so an audit failure or a racing tick can never
        // reset the single automated-recovery budget.
        if(isTransientCrawlDeadLetter(crawlJob)&&crawlJob.max_attempts<=INGEST_STAGE_MAX_ATTEMPTS) {
          const prior=await priorAutomatedRedrives(db,crawlJob.id,AUTOMATED_RECOVERY_OPERATOR);
          if(prior===null) {deferred=true;deferredLedgerUnavailable++;}
          else if(prior<MAX_AUTOMATED_CRAWL_RECOVERIES) {
            const outcome=await attemptAutomatedRedrive(db,{job:crawlJob,stage:"crawl",operator:AUTOMATED_RECOVERY_OPERATOR,
              reason:"transient-crawl-recovery:"+(crawlJob.last_error_code??"unknown"),now:input.now});
            if(outcome==="recovered") {crawlJob={...crawlJob,status:"pending",last_error_code:null,last_error_summary:null};live=true;recovered++;}
            else if(outcome==="deferred_rate_limited") {deferred=true;deferredRateLimited++;}
            else if(outcome==="deferred_ledger") {deferred=true;deferredLedgerUnavailable++;}
            else if(outcome==="deferred_racing") defer=true;
          }
        } else if(crawlJob.last_error_code===TERMINAL_RECHECK_ERROR_CODE) {
          // A final official 404/410 can become collectable later. Recheck it at
          // most once per cooldown with a distinct crawl revision so the terminal
          // row stays immutable and auditable.
          const anchor=Date.parse(String(crawlJob.updated_at??crawlJob.completed_at??""));
          if(Number.isFinite(anchor)&&Date.parse(input.now)-anchor>=TERMINAL_RECHECK_COOLDOWN_MS) {
            const rechecks=await e2eRows(db,"SELECT COUNT(*) AS count FROM ingest_stage_jobs WHERE stage='crawl' AND article_id=? AND instr(source_version,':recheck:')>0",crawlJob.article_id);
            if(Number(rechecks[0]?.count??0)<MAX_TERMINAL_RECHECKS) {
              const recheck=await registerIngestStageJob(db,{stage:"crawl",articleId:crawlJob.article_id,sourceKey:String(scan.source_key),
                sourceVersion:String(item.source_version)+":recheck:"+input.now.slice(0,10),contentHash:String(item.snapshot_hash),
                payloadRef:String(item.artifact_ref),priority:Number(item.priority),now:input.now});
              crawlJob=recheck.job;live=true;recheckScheduled++;
            } else {recheckExhausted++;live=false;}
          }
        }
        if(!live&&!deferred)terminalLinked++;
      } else if(crawlJob.status==="succeeded") {
        // The crawl succeeded but a *later* stage dead-lettered. Resume only a
        // failure that was provably retryable, once per job, under the same
        // operator rate limit. A terminal downstream block stays linked.
        const downstream=await e2eRows(db,"SELECT * FROM ingest_stage_jobs WHERE article_id=? AND stage<>'crawl' AND status='dead_letter' ORDER BY created_at,id LIMIT 1",crawlJob.article_id);
        const dead=downstream[0] as unknown as IngestStageJobRow|undefined;
        if(dead&&isRetryableStageDeadLetter(dead)) {
          const prior=await priorAutomatedRedrives(db,dead.id,AUTOMATED_DOWNSTREAM_OPERATOR);
          if(prior===null) {deferred=true;deferredLedgerUnavailable++;}
          else if(prior<MAX_AUTOMATED_DOWNSTREAM_RECOVERIES) {
            const outcome=await attemptAutomatedRedrive(db,{job:dead,stage:dead.stage,operator:AUTOMATED_DOWNSTREAM_OPERATOR,
              reason:"downstream-resume:"+dead.stage+":"+(dead.last_error_code??"unknown"),now:input.now});
            if(outcome==="recovered") {recoveredDownstream++;live=true;}
            else if(outcome==="deferred_rate_limited") {deferred=true;deferredRateLimited++;}
            else if(outcome==="deferred_ledger") {deferred=true;deferredLedgerUnavailable++;}
            else if(outcome==="deferred_racing") {deferred=true;}
            else {live=false;terminalLinked++;}
          } else {live=false;terminalLinked++;}
        } else if(dead) {live=false;terminalLinked++;}
      }
      if(deferred)break;
      const token=crypto.randomUUID();
      await batch(db,[guard(token),db.prepare("UPDATE ingest_discovery_items_v1 SET status='reserved',crawl_job_id=?,updated_at=? WHERE job_id=? AND candidate_id=? AND status='pending'").bind(crawlJob.id,input.now,scan.job_id,item.candidate_id),cleanup(db,token)]);
      if(live)reserved++;
      handled++;
    }
    const token=crypto.randomUUID();
    await batch(db,[guard(token),db.prepare("UPDATE ingest_discovery_scans_v1 SET status=CASE WHEN EXISTS(SELECT 1 FROM ingest_discovery_items_v1 WHERE job_id=? AND status='pending') THEN 'pending' ELSE 'reserved' END,reservation_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=?")
      .bind(scan.job_id,input.now,scan.job_id),cleanup(db,token)]);
    if(deferred)break;
    if(handled>=limit)break;
  }
  const pending=(await e2eRows(db,"SELECT COUNT(*) AS count,MIN(s.captured_at) AS oldest FROM ingest_discovery_items_v1 i JOIN ingest_discovery_scans_v1 s ON s.job_id=i.job_id WHERE i.status='pending'"))[0];
  const pendingCount=Number(pending.count),oldestPendingAgeSeconds=pending.oldest?Math.max(0,(Date.parse(input.now)-Date.parse(String(pending.oldest)))/1000):0;
  const stalled=(await e2eRows(db,"SELECT COUNT(*) AS count FROM ingest_discovery_scans_v1 WHERE status='capturing' AND captured_at<=?",new Date(Date.parse(input.now)-1800000).toISOString()))[0];
  const stalledCaptureCount=Number(stalled.count);
  return {claimed,reserved,recovered,recoveredDownstream,terminalLinked,recheckScheduled,recheckExhausted,
    deferredRateLimited,deferredLedgerUnavailable,pendingCount,oldestPendingAgeSeconds,stalledCaptureCount,
    requiresAttention:stalledCaptureCount>0||deferredLedgerUnavailable>0||recheckExhausted>0||(pendingCount>0&&oldestPendingAgeSeconds>1800)};
}
