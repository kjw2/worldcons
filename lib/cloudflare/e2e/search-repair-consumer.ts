import type { D1RuntimeDatabase } from "../d1/runtime-binding";
import { buildSearchProjection } from "../search-projection/build";
import { buildSearchProjectionInputFromEligibleRows, readEligibleSourceForArticle, readTagsForArticleIds } from "../search-projection/d1-sync";
import { approvalIdentity } from "./contracts";
import { currentGenerations, e2eRows, type GenerationRow } from "./generation-state";
import { applyGuardedSearchProjection, projectionMatches, searchIdentity } from "./search-generation-guard";
import { CURRENT_OUTBOX_SQL, isSearchRepairMessage } from "./search-repair-dispatcher";

export interface SearchRepairConsumerOptions { clock?:()=>string; workerId?:string; random?:()=>number }
const tagSql=`SELECT json_group_array(json_object('tag_id',tag_id,'confidence',confidence,'slug',slug,'name',name,
  'normalized_name',normalized_name,'type',type)) FROM (SELECT at.tag_id,at.confidence,t.slug,t.name,t.normalized_name,t.type
  FROM article_tags at LEFT JOIN tags t ON t.id=at.tag_id WHERE at.article_id=o.article_id ORDER BY at.tag_id COLLATE BINARY)`;
function after(now:string,seconds:number) { return new Date(Date.parse(now)+seconds*1000).toISOString(); }
async function batch(db:D1RuntimeDatabase,statements:ReturnType<D1RuntimeDatabase["prepare"]>[]) {
  if (!db.batch) throw new Error("e2e.core_batch_unavailable");
  const results=await db.batch(statements);
  if (results.length!==statements.length||results.some(r=>r.success===false||r.error)) throw new Error("e2e.core_batch_failed");
}
export async function desiredSearchProjection(core:D1RuntimeDatabase,g:GenerationRow) {
  if (!g.input_current) throw new Error("e2e.input_changed");
  if (g.expected_publication_state!=="published") return { document:null,fts:null };
  const versions=await e2eRows(core,"SELECT * FROM article_content_versions_p3 WHERE id=? AND article_id=?",g.expected_version_id,g.article_id);
  if (!versions[0] || (await approvalIdentity(String(g.article_id),versions[0],String(g.policy_version),String(g.approval_hash_schema))).approvalSnapshotHash!==g.approval_snapshot_hash) throw new Error("e2e.approval_snapshot_changed");
  const source=await readEligibleSourceForArticle(core,String(g.article_id));
  if (source.length!==1||source[0].version_id!==g.expected_version_id) throw new Error("e2e.publication_ineligible");
  const tags=await readTagsForArticleIds(core,[String(g.article_id)]);
  const built=buildSearchProjection(buildSearchProjectionInputFromEligibleRows(source,tags));
  if (built.documents.length!==1) throw new Error("e2e.projection_ineligible");
  // Re-read dynamic input after the independent projection reads.
  const current=(await currentGenerations(core,[String(g.article_id)])).get(String(g.article_id));
  if (!current?.input_current||current.generation_id!==g.generation_id||current.tag_snapshot!==g.tag_snapshot) throw new Error("e2e.input_changed");
  return { document:built.documents[0],fts:built.ftsDocuments[0] };
}

/** M3 stops at durable Search application. M4 must verify the public API before completion. */
export async function consumeSearchRepair(core:D1RuntimeDatabase,search:D1RuntimeDatabase,message:unknown,
  options:SearchRepairConsumerOptions={}) {
  if (!isSearchRepairMessage(message)) return { status:"invalid" } as const;
  const clock=()=>new Date(options.clock?.()??Date.now()).toISOString();
  const now=clock(), owner=options.workerId??`e2e-consumer:${crypto.randomUUID()}`;
  if (!owner.trim()||owner.length>160) throw new Error("e2e.invalid_consumer_owner");
  const row=(await e2eRows(core,"SELECT * FROM e2e_search_repair_outbox_v1 WHERE outbox_id=?",message.outboxId))[0];
  if (!row) return { status:"missing" } as const;
  if (["verified","superseded","dead_letter"].includes(String(row.status))) return { status:"terminal" } as const;
  if (row.status==="leased"&&String(row.lease_expires_at)>now) return { status:"retry" } as const;
  if (String(row.next_attempt_at)>now) return { status:"retry" } as const;
  const g=(await currentGenerations(core,[String(row.article_id)])).get(String(row.article_id));
  if (!g||g.generation_id!==row.generation_id) return { status:"superseded" } as const;
  if (!g.input_current) return { status:"blocked" } as const;
  let projection:Awaited<ReturnType<typeof desiredSearchProjection>>|undefined;
  try {
    projection=await desiredSearchProjection(core,g);
    const receipts=await e2eRows(core,"SELECT * FROM e2e_search_apply_receipts_v1 WHERE generation_id=?",g.generation_id);
    if (receipts[0]&&await projectionMatches(search,searchIdentity(g,Number(receipts[0].fencing_token)),projection.document,projection.fts)) {
      const latest=(await currentGenerations(core,[String(row.article_id)])).get(String(row.article_id));
      return { status:latest?.input_current&&latest.generation_id===g.generation_id?"awaiting_verification":"superseded" } as const;
    }
  } catch {
    // Missing/corrupt Search state and projection failures go through the
    // actual-owner processing budget. Queue duplicates do not own attempts.
    projection=undefined;
  }
  // A crash on the final leased attempt must not leave an unclaimable row forever.
  // Close exhausted work only after its owner expired, and fence that owner out.
  const exhausted=`o.outbox_id=? AND (o.status IN ('pending','retry_wait') OR
    (o.status='leased' AND o.lease_expires_at<=?)) AND ${CURRENT_OUTBOX_SQL}
    AND (o.attempt_count>=o.max_attempts OR (o.first_failure_at IS NOT NULL AND o.first_failure_at<=?))`;
  const exhaustedValues=[row.outbox_id,now,after(now,-7200)];
  if (Number(row.attempt_count)>=Number(row.max_attempts)
    || (row.first_failure_at&&Date.parse(now)-Date.parse(String(row.first_failure_at))>=7200000)) {
    if (!core.batch) throw new Error("e2e.core_batch_unavailable");
    const results=await core.batch([
      core.prepare(`UPDATE e2e_generation_progress_v1 SET state='dead_letter',last_error_code='e2e.search_budget_exhausted',
        updated_at=? WHERE generation_id=? AND state<>'completed_verified'
        AND EXISTS (SELECT 1 FROM e2e_search_repair_outbox_v1 o WHERE ${exhausted})`).bind(now,g.generation_id,...exhaustedValues),
      core.prepare(`UPDATE e2e_search_repair_outbox_v1 AS o SET status='dead_letter',claimed_by=NULL,lease_expires_at=NULL,
        fencing_token=fencing_token+1,last_error_code='e2e.search_budget_exhausted',updated_at=?
        WHERE ${exhausted} RETURNING outbox_id`).bind(now,...exhaustedValues)]);
    if (results.length!==2||results.some(r=>r.success===false||r.error)) throw new Error("e2e.failure_record_unavailable");
    return {status:results[1].results?.length===1?"dead_letter":"retry"} as const;
  }
  const claimed=(await e2eRows(core,`UPDATE e2e_search_repair_outbox_v1 AS o SET status='leased',claimed_by=?,
    lease_expires_at=?,fencing_token=fencing_token+1,attempt_count=attempt_count+1,updated_at=?
    WHERE outbox_id=? AND fencing_token=? AND attempt_count<max_attempts AND next_attempt_at<=?
      AND (status IN ('pending','retry_wait') OR (status='leased' AND lease_expires_at<=?)) AND ${CURRENT_OUTBOX_SQL}
    RETURNING *`,owner,after(now,300),now,row.outbox_id,row.fencing_token,now,now))[0];
  if (!claimed) return { status:"retry" } as const;
  const ownership=`o.outbox_id=? AND o.status='leased' AND o.claimed_by=? AND o.fencing_token=?
    AND o.lease_expires_at>? AND ${CURRENT_OUTBOX_SQL}`;
  const ownershipValues=(at:string)=>[row.outbox_id,owner,claimed.fencing_token,at];
  try {
    projection??=await desiredSearchProjection(core,g);
    const latest=(await currentGenerations(core,[String(row.article_id)])).get(String(row.article_id));
    if (!latest?.input_current||latest.generation_id!==g.generation_id||latest.tag_snapshot!==g.tag_snapshot) throw new Error("e2e.input_changed");
    const identity=searchIdentity(g,Number(claimed.fencing_token));
    const fingerprints=await applyGuardedSearchProjection(search,identity,projection.document,projection.fts,clock());
    if (!await projectionMatches(search,identity,projection.document,projection.fts)) throw new Error("e2e.search_readback_failed");
    const settled=clock(), token=crypto.randomUUID();
    // A zero-row lease/CAS outcome must abort receipt/progress/outbox together.
    await batch(core,[core.prepare(`INSERT INTO e2e_commit_guards_v1 (token,assertion)
      VALUES (?,CASE WHEN EXISTS (SELECT 1 FROM e2e_search_repair_outbox_v1 o WHERE ${ownership}
        AND (SELECT review_state FROM articles WHERE id=o.article_id) IS ? AND (${tagSql})=?) THEN 1 ELSE 0 END)`).bind(
        token,...ownershipValues(settled),g.review_state??null,g.tag_snapshot),
      core.prepare(`INSERT INTO e2e_search_apply_receipts_v1 (generation_id,outbox_id,fencing_token,document_fingerprint,fts_fingerprint,applied_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(generation_id) DO UPDATE SET fencing_token=excluded.fencing_token,
        document_fingerprint=excluded.document_fingerprint,fts_fingerprint=excluded.fts_fingerprint,applied_at=excluded.applied_at`).bind(
          g.generation_id,row.outbox_id,claimed.fencing_token,fingerprints.documentFingerprint,fingerprints.ftsFingerprint,settled),
      core.prepare(`UPDATE e2e_generation_progress_v1 SET state='search_pending',expected_search_fingerprint=?,
        expected_fts_fingerprint=?,last_error_code=NULL,updated_at=? WHERE generation_id=? AND state<>'completed_verified'`).bind(
          fingerprints.documentFingerprint,fingerprints.ftsFingerprint,settled,g.generation_id),
      core.prepare(`UPDATE e2e_search_repair_outbox_v1 SET status='pending',claimed_by=NULL,lease_expires_at=NULL,
        last_error_code=NULL,next_attempt_at=?,updated_at=? WHERE outbox_id=?`).bind(after(settled,60),settled,row.outbox_id),
      core.prepare("DELETE FROM e2e_commit_guards_v1 WHERE token=?").bind(token)]);
    return { status:"awaiting_verification" } as const;
  } catch {
    const settled=clock(), first=claimed.first_failure_at?String(claimed.first_failure_at):settled;
    const dead=Number(claimed.attempt_count)>=Number(claimed.max_attempts)||Date.parse(settled)-Date.parse(first)>=7200000;
    const jitter=options.random?.()??0.5;
    if (!Number.isFinite(jitter)||jitter<0||jitter>1) throw new Error("e2e.invalid_consumer_jitter");
    const delay=Math.floor(Math.min(900,60*2**Math.min(Number(claimed.attempt_count)-1,10)*(0.8+0.4*jitter)));
    const errorCode="e2e.search_processing_failed";
    const results=await core.batch!([
      core.prepare(`UPDATE e2e_generation_progress_v1 SET state=?,last_error_code=?,updated_at=? WHERE generation_id=?
        AND state<>'completed_verified' AND EXISTS (SELECT 1 FROM e2e_search_repair_outbox_v1 o WHERE ${ownership})`).bind(
          dead?"dead_letter":"retry_wait",errorCode,settled,g.generation_id,...ownershipValues(settled)),
      core.prepare(`UPDATE e2e_search_repair_outbox_v1 AS o SET status=?,claimed_by=NULL,lease_expires_at=NULL,
        first_failure_at=COALESCE(first_failure_at,?),next_attempt_at=?,last_error_code=?,updated_at=?
        WHERE ${ownership} RETURNING outbox_id`).bind(dead?"dead_letter":"retry_wait",first,after(settled,delay),errorCode,settled,...ownershipValues(settled))]);
    if (results.some(r=>r.success===false||r.error)) throw new Error("e2e.failure_record_unavailable");
    return { status:results[1].results?.length===1?(dead?"dead_letter":"retry"):"retry" } as const;
  }
}
