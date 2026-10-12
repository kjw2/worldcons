import type { D1RuntimeDatabase } from "../d1/runtime-binding";
import { e2eRows, hasE2ETable, type GenerationRow } from "../e2e/generation-state";
import { projectionFingerprints } from "../e2e/search-generation-guard";
import { SEARCH_DOCUMENT_COLUMNS, SEARCH_FTS_COLUMNS, type SearchProjectionDocument, type SearchProjectionFtsDocument } from "./types";

export async function metadataRepairReady(core:D1RuntimeDatabase,search:D1RuntimeDatabase) {
  return await hasE2ETable(core,"search_metadata_repairs_v1") && await hasE2ETable(search,"search_metadata_guards_v1");
}
export async function invalidateSearchMetadata(core:D1RuntimeDatabase,id:string,now=new Date().toISOString()) {
  await core.prepare(`INSERT INTO search_metadata_repairs_v1(article_id,revision,status,updated_at) VALUES(?,1,'pending',?)
    ON CONFLICT(article_id) DO UPDATE SET revision=revision+1,status='pending',fencing_token=fencing_token+1,lease_until=NULL,attempt_count=0,next_attempt_at=NULL,updated_at=excluded.updated_at`).bind(id,now).all();
}
export async function claimMetadataRepair(core:D1RuntimeDatabase,id:string,now=new Date().toISOString()) {
  const lease=new Date(Date.parse(now)+120000).toISOString();
  const rows=await e2eRows(core,`UPDATE search_metadata_repairs_v1 SET status='leased',fencing_token=fencing_token+1,attempt_count=attempt_count+1,lease_until=?,updated_at=?
    WHERE article_id=? AND attempt_count<8 AND (status='pending' OR (status='retry_wait' AND next_attempt_at<=?) OR (status='leased' AND lease_until<=?)) RETURNING *`,lease,now,id,now,now);
  const claim=rows[0];
  if(claim)await core.prepare("INSERT INTO search_metadata_attempts_v1(article_id,revision,fencing_token,status,started_at) VALUES(?,?,?,'leased',?)").bind(id,claim.revision,claim.fencing_token,now).all();
  return claim;
}
export async function finishMetadataRepair(core:D1RuntimeDatabase,c:GenerationRow,error?:unknown,now=new Date().toISOString()) {
  const code=error?String(error instanceof Error?error.message:error).slice(0,200):null;
  const status=error?(Number(c.attempt_count)>=8?'dead_letter':'retry_wait'):'verified';
  const next=new Date(Date.parse(now)+Math.min(3600,30*2**Number(c.attempt_count))*1000).toISOString();
  if(!core.batch)throw new Error('metadata.batch_unavailable');
  const results=await core.batch([core.prepare(`UPDATE search_metadata_repairs_v1 SET status=?,applied_revision=CASE WHEN ?='verified' THEN revision ELSE applied_revision END,verified_at=CASE WHEN ?='verified' THEN ? ELSE verified_at END,lease_until=NULL,next_attempt_at=?,first_failure_at=CASE WHEN ? IS NOT NULL THEN COALESCE(first_failure_at,?) ELSE first_failure_at END,last_error_code=?,updated_at=? WHERE article_id=? AND revision=? AND fencing_token=? AND status='leased'`).bind(status,status,status,now,error?next:null,code,now,code,now,c.article_id,c.revision,c.fencing_token),core.prepare("UPDATE search_metadata_attempts_v1 SET status=?,error_code=?,finished_at=? WHERE article_id=? AND revision=? AND fencing_token=?").bind(status,code,now,c.article_id,c.revision,c.fencing_token)]);
  if(results.some(r=>r.success===false||r.error))throw new Error('metadata.core_batch_failed');
  if(Number(results[0]?.meta?.changes)!==1)await core.prepare("UPDATE search_metadata_attempts_v1 SET status='superseded',finished_at=? WHERE article_id=? AND revision=? AND fencing_token=?").bind(now,c.article_id,c.revision,c.fencing_token).all();
}

/** A legacy attempt cannot overwrite a newer metadata attempt or an E2E generation. */
export async function applyMetadataProjection(search:D1RuntimeDatabase,c:GenerationRow,document:SearchProjectionDocument|null,fts:SearchProjectionFtsDocument|null,now=new Date().toISOString()) {
  if(!search.batch)throw new Error('metadata.batch_unavailable');
  const token=crypto.randomUUID(),fp=await projectionFingerprints(document,fts);
  const statements=[search.prepare(`INSERT INTO e2e_search_commit_guards_v1(token,assertion) VALUES(?,CASE WHEN NOT EXISTS(SELECT 1 FROM e2e_search_generation_guards_v1 WHERE article_id=?) AND NOT EXISTS(SELECT 1 FROM search_metadata_guards_v1 WHERE article_id=? AND (revision>? OR (revision=? AND fencing_token>?))) THEN 1 ELSE 0 END)`).bind(token,c.article_id,c.article_id,c.revision,c.revision,c.fencing_token),
    search.prepare("INSERT INTO search_metadata_authorizations_v1(article_id,token) VALUES(?,?)").bind(c.article_id,token),
    search.prepare("DELETE FROM search_fts WHERE article_id=?").bind(c.article_id),search.prepare("DELETE FROM search_documents WHERE article_id=?").bind(c.article_id)];
  if(document&&fts) {
    statements.push(search.prepare(`INSERT INTO search_documents(${SEARCH_DOCUMENT_COLUMNS.join(',')}) VALUES(${SEARCH_DOCUMENT_COLUMNS.map(()=>'?').join(',')})`).bind(...SEARCH_DOCUMENT_COLUMNS.map(k=>document[k])));
    statements.push(search.prepare(`INSERT INTO search_fts(${SEARCH_FTS_COLUMNS.join(',')}) VALUES(${SEARCH_FTS_COLUMNS.map(()=>'?').join(',')})`).bind(...SEARCH_FTS_COLUMNS.map(k=>fts[k])));
  }
  statements.push(search.prepare(`INSERT INTO search_metadata_guards_v1(article_id,revision,fencing_token,document_fingerprint,fts_fingerprint,tombstone,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET revision=excluded.revision,fencing_token=excluded.fencing_token,document_fingerprint=excluded.document_fingerprint,fts_fingerprint=excluded.fts_fingerprint,tombstone=excluded.tombstone,updated_at=excluded.updated_at`).bind(c.article_id,c.revision,c.fencing_token,fp.documentFingerprint,fp.ftsFingerprint,Number(document===null),now),search.prepare("DELETE FROM search_metadata_authorizations_v1 WHERE article_id=? AND token=?").bind(c.article_id,token),search.prepare("DELETE FROM e2e_search_commit_guards_v1 WHERE token=?").bind(token));
  const result=await search.batch(statements);
  if(result.some(r=>r.success===false||r.error))throw new Error('metadata.search_batch_failed');
  const [docs,ftsRows]=await Promise.all([e2eRows(search,"SELECT * FROM search_documents WHERE article_id=?",c.article_id),e2eRows(search,"SELECT * FROM search_fts WHERE article_id=?",c.article_id)]);
  const actual=await projectionFingerprints(docs.length===1?docs[0] as unknown as SearchProjectionDocument:null,ftsRows.length===1?ftsRows[0] as unknown as SearchProjectionFtsDocument:null);
  if(docs.length!==Number(document!==null)||ftsRows.length!==Number(fts!==null)||actual.documentFingerprint!==fp.documentFingerprint||actual.ftsFingerprint!==fp.ftsFingerprint)throw new Error('metadata.projection_mismatch');
}

export async function drainSearchMetadataRepairs(bindings:{WORLDCONS_CORE:D1RuntimeDatabase;WORLDCONS_SEARCH:D1RuntimeDatabase},limit=10) {
  if(!await metadataRepairReady(bindings.WORLDCONS_CORE,bindings.WORLDCONS_SEARCH))return {ready:false,processed:0,failed:0};
  const now=new Date().toISOString();
  await bindings.WORLDCONS_CORE.prepare("UPDATE search_metadata_repairs_v1 SET status='dead_letter',lease_until=NULL,last_error_code='metadata.lease_budget_exhausted',first_failure_at=COALESCE(first_failure_at,?),updated_at=? WHERE status='leased' AND lease_until<=? AND attempt_count>=8").bind(now,now,now).all();
  const due=await e2eRows(bindings.WORLDCONS_CORE,`SELECT article_id FROM search_metadata_repairs_v1 WHERE status='pending' OR (status='retry_wait' AND next_attempt_at<=?) OR (status='leased' AND lease_until<=?) ORDER BY updated_at LIMIT ?`,now,now,Math.max(1,Math.min(50,limit)));
  const {syncSearchProjectionForArticle}=await import('./d1-sync');
  let failed=0;
  for(const row of due)try{await syncSearchProjectionForArticle(bindings,String(row.article_id));}catch(error){failed++;console.error(JSON.stringify({event:'search_metadata_repair_failed',articleId:row.article_id,error:String(error).slice(0,200)}));}
  const health=(await e2eRows(bindings.WORLDCONS_CORE,"SELECT SUM(CASE WHEN status='dead_letter' THEN 1 ELSE 0 END) AS dead_letters,SUM(CASE WHEN status IN ('pending','leased','retry_wait') THEN 1 ELSE 0 END) AS pending,MIN(CASE WHEN status IN ('pending','leased','retry_wait') THEN updated_at END) AS oldest_pending FROM search_metadata_repairs_v1"))[0];
  const deadLetterCount=Number(health.dead_letters??0),pendingCount=Number(health.pending??0),oldestPendingAgeSeconds=health.oldest_pending?Math.max(0,(Date.parse(now)-Date.parse(String(health.oldest_pending)))/1000):0;
  const requiresAttention=failed>0||deadLetterCount>0||oldestPendingAgeSeconds>900;
  if(requiresAttention)console.error(JSON.stringify({event:'search_metadata_requires_attention',deadLetterCount,pendingCount,oldestPendingAgeSeconds}));
  return {ready:true,processed:due.length,failed,deadLetterCount,pendingCount,oldestPendingAgeSeconds,requiresAttention};
}

/** Batched Core read gate; disabled until both compatible workers are deployed. */
export async function readPublicMetadataState(core:D1RuntimeDatabase,ids:readonly string[],managed:Set<string>) {
  const states=new Map<string,GenerationRow>();
  if(!ids.length||!await hasE2ETable(core,'search_metadata_policy_v1'))return states;
  const policy=(await e2eRows(core,'SELECT public_read_required FROM search_metadata_policy_v1 WHERE id=1'))[0];
  if(Number(policy?.public_read_required)!==1)return states;
  const legacy=ids.filter(id=>!managed.has(id));
  for(let offset=0;offset<legacy.length;offset+=80){const part=legacy.slice(offset,offset+80);
    for(const row of await e2eRows(core,`SELECT * FROM search_metadata_repairs_v1 WHERE article_id IN (${part.map(()=>'?').join(',')})`,...part)){
      if(row.status!=='verified'||Number(row.revision)!==Number(row.applied_revision))throw new Error('e2e.public_metadata_pending');
      states.set(String(row.article_id),row);
    }
  }
  return states;
}
