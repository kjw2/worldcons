import { allPredicates } from "./sql-predicates";
import type { D1RuntimeDatabase } from "../d1/runtime-binding";
import { canonicalJson } from "@/lib/backfill/canonical-json";
import { canonicalArticleCaseNumber, normalizeCaseNumber } from "@/lib/search/case-number";
import { approvalIdentity, sha256Canonical, HUMAN_APPROVAL_POLICY, REMOVAL_AUTHORITY_POLICY, STAGED_APPROVAL_POLICY } from "./contracts";
import { currentGenerations, e2eRows, type GenerationRow } from "./generation-state";
import { desiredSearchProjection } from "./search-repair-consumer";
import { projectionFingerprints, projectionMatches, inspectSearchProjection, searchIdentity } from "./search-generation-guard";
import { CURRENT_OUTBOX_SQL, isSearchRepairMessage } from "./search-repair-dispatcher";

export interface SearchVerificationOptions {
  apiBaseUrl:string;
  fetch?:typeof fetch;
  clock?:()=>string;
  workerId?:string;
  deploymentRef:string;
}
function after(now:string,seconds:number) { return new Date(Date.parse(now)+seconds*1000).toISOString(); }
export function verificationApiBase(value:string) {
  const url=new URL(value);
  if (url.protocol!=="https:"||url.username||url.password||url.search||url.hash
    || !/^\/api(?:\/cclrag2)?\/?$/.test(url.pathname)) throw new Error("e2e.invalid_verification_api_base");
  return url.href.replace(/\/$/,"");
}
function record(value:unknown):GenerationRow {
  if (!value||typeof value!=="object"||Array.isArray(value)) throw new Error("e2e.api_contract_mismatch");
  return value as GenerationRow;
}
async function probe(url:string,options:SearchVerificationOptions,clock:()=>string) {
  const response=await (options.fetch??fetch)(url,{redirect:"error",cache:"no-store",signal:AbortSignal.timeout(8000),
    headers:{"cache-control":"no-cache","x-request-id":crypto.randomUUID()}});
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[]; let size=0;
  if (reader) try {
    for (;;) { const part=await reader.read(); if (part.done) break; size+=part.value.byteLength;
      if (size>500000) { await reader.cancel(); throw new Error("e2e.api_response_too_large"); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  const bytes=new Uint8Array(size); let offset=0; for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.byteLength; }
  const text=new TextDecoder().decode(bytes);
  const body=record(JSON.parse(text));
  return {status:response.status,body,evidence:{url,status:response.status,observedAt:clock(),
    responseHash:await sha256Canonical(body),cacheControl:response.headers.get("cache-control")}};
}
function checkItem(item:GenerationRow,v:GenerationRow,base:string) {
  const metadata=typeof v.source_metadata==="string"?JSON.parse(v.source_metadata):v.source_metadata;
  const caseNumber=canonicalArticleCaseNumber({sourceKey:String(v.source_key),originalTitle:String(v.original_title),metadata});
  const title=String(v.korean_title||v.original_title).trim(),original=String(v.original_url).trim(),canonical=String(v.canonical_url||v.original_url).trim();
  if (item.id!==v.article_id||item.slug!==v.slug||item.title!==title||item.caseNumber!==(caseNumber??null)
    || item.originalUrl!==original||item.canonicalUrl!==canonical||item.detailApiUrl!==`${base}/articles/${encodeURIComponent(String(v.slug))}`)
    throw new Error("e2e.api_identity_mismatch");
}
const tagsSql=`SELECT json_group_array(json_object('tag_id',tag_id,'confidence',confidence,'slug',slug,'name',name,
  'normalized_name',normalized_name,'type',type)) FROM (SELECT at.tag_id,at.confidence,t.slug,t.name,t.normalized_name,t.type
  FROM article_tags at LEFT JOIN tags t ON t.id=at.tag_id WHERE at.article_id=o.article_id ORDER BY at.tag_id COLLATE BINARY)`;

/** Single-Article set/content/API verification; this is not a corpus-wide audit. */
export async function verifySearchRepair(core:D1RuntimeDatabase,search:D1RuntimeDatabase,message:unknown,
  options:SearchVerificationOptions) {
  if (!isSearchRepairMessage(message)) return {status:"invalid"} as const;
  const base=verificationApiBase(options.apiBaseUrl);
  if (!options.deploymentRef.trim()||options.deploymentRef.length>500) throw new Error("e2e.verification_deployment_ref_required");
  const clock=()=>new Date(options.clock?.()??Date.now()).toISOString(),now=clock();
  const owner=options.workerId??`e2e-verifier:${crypto.randomUUID()}`;
  if (!owner.trim()||owner.length>160) throw new Error("e2e.invalid_verifier_owner");
  const row=(await e2eRows(core,"SELECT * FROM e2e_search_repair_outbox_v1 WHERE outbox_id=?",message.outboxId))[0];
  if (!row) return {status:"missing"} as const;
  const g=(await currentGenerations(core,[String(row.article_id)])).get(String(row.article_id));
  if (!g||g.generation_id!==row.generation_id||row.status==="superseded") return {status:"superseded"} as const;
  if (!g.input_current) return {status:"blocked"} as const;
  if (row.status==="verified") return {status:"already_verified"} as const;
  if (row.status==="dead_letter") return {status:"dead_letter"} as const;
  const receipt=(await e2eRows(core,"SELECT * FROM e2e_search_apply_receipts_v1 WHERE generation_id=?",g.generation_id))[0];
  if (!receipt||Number(receipt.fencing_token)!==Number(row.fencing_token)||row.status==="leased") return {status:"awaiting_application"} as const;
  await e2eRows(core,`INSERT INTO e2e_verification_jobs_v1 (generation_id,next_attempt_at,updated_at)
    VALUES (?,?,?) ON CONFLICT(generation_id) DO NOTHING`,g.generation_id,now,now);
  const job=(await e2eRows(core,"SELECT * FROM e2e_verification_jobs_v1 WHERE generation_id=?",g.generation_id))[0];
  if (["dead_letter","blocked"].includes(String(job.status))) return {status:"dead_letter"} as const;
  if (job.status==="leased"&&String(job.lease_expires_at)>now||String(job.next_attempt_at)>now) return {status:"retry"} as const;
  const current=`EXISTS (SELECT 1 FROM e2e_search_repair_outbox_v1 o
    JOIN e2e_search_apply_receipts_v1 r ON r.generation_id=o.generation_id
    WHERE o.generation_id=j.generation_id AND o.outbox_id=? AND o.status IN ('pending','retry_wait')
      AND o.fencing_token=? AND r.fencing_token=o.fencing_token AND ${CURRENT_OUTBOX_SQL})`;
  const currentValues=[row.outbox_id,receipt.fencing_token];
  // Verification failures have their own budget. Exhaustion atomically stops
  // dispatcher redispatch without consuming or changing the Search apply budget.
  const settleFailure=async(at:string,code:string,dead:boolean,due:string,where:string,values:unknown[])=>{
    if (!core.batch) return false;
    const token=crypto.randomUUID();
    const statements=[
      core.prepare(`INSERT INTO e2e_commit_guards_v1 (token,assertion) VALUES (?,CASE WHEN EXISTS
        (SELECT 1 FROM e2e_verification_jobs_v1 j WHERE ${where}) THEN 1 ELSE 0 END)`).bind(token,...values),
      core.prepare(`UPDATE e2e_verification_jobs_v1 SET status=?,first_failure_at=COALESCE(first_failure_at,?),
        next_attempt_at=?,last_error_code=?,claimed_by=NULL,lease_expires_at=NULL,verification_fence=verification_fence+1,
        updated_at=? WHERE generation_id=?`).bind(dead?"dead_letter":"retry_wait",at,due,code,at,g.generation_id),
    ];
    if (dead) statements.push(
      core.prepare(`UPDATE e2e_search_repair_outbox_v1 SET status='dead_letter',last_error_code=?,
        claimed_by=NULL,lease_expires_at=NULL,dispatch_owner=NULL,dispatch_token=NULL,dispatch_lease_expires_at=NULL,
        dispatch_fence=dispatch_fence+1,updated_at=? WHERE outbox_id=?`).bind(code,at,row.outbox_id),
      core.prepare(`UPDATE e2e_generation_progress_v1 SET state='dead_letter',last_error_code=?,updated_at=?
        WHERE generation_id=?`).bind(code,at,g.generation_id));
    statements.push(core.prepare("DELETE FROM e2e_commit_guards_v1 WHERE token=?").bind(token));
    try { const results=await core.batch(statements); return results.length===statements.length&&results.every(r=>r.success!==false&&!r.error); }
    catch { return false; } // Lost ownership or failed batch never completes or overwrites a newer attempt.
  };
  if (Number(job.attempt_count)>=Number(job.max_attempts)
    || job.first_failure_at&&Date.parse(now)-Date.parse(String(job.first_failure_at))>=7200000) {
    const ended=await settleFailure(now,"e2e.verification_budget_exhausted",true,now,
      `j.generation_id=? AND j.verification_fence=? AND (j.status IN ('pending','retry_wait')
        OR (j.status='leased' AND j.lease_expires_at<=?)) AND ${current}`,[g.generation_id,job.verification_fence,now,...currentValues]);
    return {status:ended?"dead_letter":"retry"} as const;
  }
  const claimed=(await e2eRows(core,`UPDATE e2e_verification_jobs_v1 AS j SET status='leased',claimed_by=?,lease_expires_at=?,
    verification_fence=verification_fence+1,applied_fence=?,attempt_count=attempt_count+1,updated_at=?
    WHERE generation_id=? AND verification_fence=? AND next_attempt_at<=?
      AND (status IN ('pending','retry_wait') OR (status='leased' AND lease_expires_at<=?)) AND ${current}
    RETURNING *`,owner,after(now,300),receipt.fencing_token,now,g.generation_id,job.verification_fence,now,now,...currentValues))[0];
  if (!claimed) return {status:"retry"} as const;
  const ownership=`j.generation_id=? AND j.status='leased' AND j.claimed_by=? AND j.verification_fence=?
    AND j.lease_expires_at>? AND ${current}`;
  const ownershipValues=(at:string)=>[g.generation_id,owner,claimed.verification_fence,at,...currentValues];
  try {
    const version=(await e2eRows(core,"SELECT * FROM article_content_versions_p3 WHERE id=? AND article_id=?",g.expected_version_id,g.article_id))[0];
    if (!version) throw new Error("e2e.approved_version_missing");
    const identity=await approvalIdentity(String(g.article_id),version,String(g.policy_version),String(g.approval_hash_schema));
    const approval=(await e2eRows(core,"SELECT * FROM e2e_approval_evidence_v1 WHERE approval_key=?",g.approval_key))[0];
    if (!approval||approval.article_id!==g.article_id||approval.approval_snapshot_hash!==identity.approvalSnapshotHash
      || identity.approvalSnapshotHash!==g.approval_snapshot_hash||identity.approvalKey!==g.approval_key
      || approval.source_content_hash!==g.source_content_hash||approval.evidence_ref!==g.approval_evidence_ref
      || approval.source_artifact_ref!==g.source_evidence_ref||approval.policy_version!==g.policy_version
      || approval.discovery_candidate_id!==g.discovery_candidate_id||approval.pipeline_run_id!==g.pipeline_run_id)
      throw new Error("e2e.approval_evidence_mismatch");
    const proof=record(JSON.parse(String(approval.evidence_document))),checks=record(proof.checks);
    if (proof.articleId!==g.article_id||proof.approvalKey!==g.approval_key
      || proof.approvalSnapshotHash!==g.approval_snapshot_hash||proof.sourceContentHash!==g.source_content_hash
      || proof.policyVersion!==g.policy_version||proof.sourceArtifactRef!==g.source_evidence_ref
      || proof.sourceArtifactHash!==approval.source_artifact_hash||proof.candidateId!==g.discovery_candidate_id||proof.pipelineRunId!==g.pipeline_run_id
      || !/^[a-f0-9]{64}$/.test(String(proof.sourceArtifactHash))
      )
      throw new Error("e2e.approval_evidence_mismatch");
    const automatic=proof.schema==="worldcons.automatic-approval.v1"&&g.policy_version===STAGED_APPROVAL_POLICY&&g.approval_mode==="automatic"
      &&["sourceTextMatches","officialHost","publicPermission","translationPersisted","summarySchema","noRiskFlags","noReviewBlock"].every(key=>checks[key]===true);
    const human=proof.schema==="worldcons.human-approval.v1"&&g.policy_version===HUMAN_APPROVAL_POLICY&&g.approval_mode==="human"&&typeof proof.actorId==="string"&&proof.actorId.length>0
      &&["reviewedExactSnapshot","officialHost","publicPermission","summarySchema","riskFlagsAcknowledged"].every(key=>checks[key]===true);
    const removal=proof.schema==="worldcons.removal-authority.v1"&&g.policy_version===REMOVAL_AUTHORITY_POLICY&&g.expected_publication_state!=="published"
      &&proof.noPublicApproval===true&&proof.targetState===g.expected_publication_state&&checks.exactSnapshot===true&&checks.removalOnly===true;
    if(!automatic&&!human&&!removal)throw new Error("e2e.approval_evidence_mismatch");
    if((human||removal)&&(await sha256Canonical(proof.sourceArtifact)!==approval.source_artifact_hash
      ||record(proof.sourceArtifact).cleanedText!==version.cleaned_text||record(proof.sourceArtifact).canonicalUrl!==version.canonical_url))throw new Error("e2e.approval_evidence_mismatch");
    const projection=await desiredSearchProjection(core,g),fingerprints=await projectionFingerprints(projection.document,projection.fts);
    if (fingerprints.documentFingerprint!==receipt.document_fingerprint||fingerprints.ftsFingerprint!==receipt.fts_fingerprint
      || !await projectionMatches(search,searchIdentity(g,Number(receipt.fencing_token)),projection.document,projection.fts))
      throw new Error("e2e.search_content_mismatch");
    const detail=await probe(`${base}/articles/${encodeURIComponent(String(version.slug))}?textLimit=4000`,options,clock);
    const caseNumber=canonicalArticleCaseNumber({sourceKey:String(version.source_key),originalTitle:String(version.original_title),
      metadata:typeof version.source_metadata==="string"?JSON.parse(version.source_metadata):version.source_metadata})
      ??(removal?normalizeCaseNumber(String(version.source_key),String(version.original_title)):undefined);
    if (!caseNumber) throw new Error("e2e.verification_case_number_missing");
    const searchUrl=new URL(`${base}/search`);
    searchUrl.search=new URLSearchParams({q:caseNumber,mode:"fulltext",source:String(version.source_key),pageSize:"20",count:"none"}).toString();
    const result=await probe(searchUrl.href,options,clock);
    const items=result.body.items;
    if (g.expected_publication_state==="published") {
      if (detail.status!==200||result.status!==200||!Array.isArray(items)) throw new Error("e2e.public_api_unavailable");
      checkItem(detail.body,version,base);
      const matches=items.filter(item=>record(item).id===g.article_id);
      if (matches.length!==1) throw new Error("e2e.search_api_set_mismatch");
      checkItem(record(matches[0]),version,base);
      const expectedText=Array.from(String(version.cleaned_text)).slice(0,4000).join("").trim();
      if (detail.body.cleanedText!==expectedText) throw new Error("e2e.detail_body_mismatch");
      const summary=JSON.parse(String(version.summary_json));
      if (canonicalJson(detail.body.summaryJson)!==canonicalJson(summary)) throw new Error("e2e.detail_summary_mismatch");
    } else {
      if (detail.status!==404||result.status!==200||!Array.isArray(items)
        || items.some(item=>record(item).id===g.article_id)) throw new Error("e2e.withdrawal_api_mismatch");
    }
    // Recalculate actual content after HTTP probes, then recheck Core. Core commit
    // below independently CAS-checks ownership/head/input; there is no global D1 transaction.
    const observation=await inspectSearchProjection(search,searchIdentity(g,Number(receipt.fencing_token)),projection.document,projection.fts);
    if (!observation.matches) throw new Error("e2e.search_changed_during_verification");
    const latest=(await currentGenerations(core,[String(g.article_id)])).get(String(g.article_id));
    if (!latest?.input_current||latest.generation_id!==g.generation_id||latest.tag_snapshot!==g.tag_snapshot) throw new Error("e2e.generation_changed_during_verification");
    const settled=clock(),resultKind=g.expected_publication_state==="published"?"completed_verified":"withdrawal_verified";
    const columns=Object.keys(version);
    if (columns.some(c=>!/^[_a-z][_a-z0-9]*$/.test(c))) throw new Error("e2e.invalid_snapshot_column");
    const snapshotSql=allPredicates(columns.map(c=>`"${c}" IS ?`));
    const document={schema:"worldcons.verification.v1",scope:"single_article",articleId:g.article_id,caseNumber,
      generationId:g.generation_id,generationSeq:g.generation_seq,
      versionId:g.expected_version_id,versionRevision:g.expected_version_revision,publicationId:g.expected_publication_id,
      publicationRevision:g.expected_publication_revision,policyVersion:g.policy_version,approvalKey:g.approval_key,
      projectionInputHash:g.projection_input_hash,appliedFence:receipt.fencing_token,verificationFence:claimed.verification_fence,
      approvalEvidenceRef:g.approval_evidence_ref,sourceEvidenceRef:g.source_evidence_ref,
      result:resultKind,documentFingerprint:fingerprints.documentFingerprint,ftsFingerprint:fingerprints.ftsFingerprint,
      expected:{documentCount:projection.document?1:0,ftsCount:projection.fts?1:0,...fingerprints},observed:observation,
      apiChecks:{exactArticleIdentity:true,expectedSearchMembership:true,detailTextLimit:4000,
        approvedBodyPrefixMatches:g.expected_publication_state==="published",approvedSummaryMatches:g.expected_publication_state==="published"},
      probes:[detail.evidence,result.evidence],deploymentRef:options.deploymentRef,verifiedAt:settled};
    const evidenceId=await sha256Canonical(document),token=crypto.randomUUID();
    if (!core.batch) throw new Error("e2e.verification_batch_unavailable");
    const results=await core.batch([
      core.prepare(`INSERT INTO e2e_commit_guards_v1 (token,assertion) VALUES (?,CASE WHEN EXISTS
        (SELECT 1 FROM e2e_verification_jobs_v1 j JOIN e2e_search_repair_outbox_v1 o ON o.generation_id=j.generation_id
          WHERE ${ownership}) THEN 1 ELSE 0 END)`).bind(token,...ownershipValues(settled)),
      core.prepare(`INSERT INTO e2e_commit_guards_v1 (token,assertion) VALUES (?,CASE WHEN EXISTS
        (SELECT 1 FROM e2e_search_repair_outbox_v1 o WHERE o.outbox_id=?
          AND (SELECT review_state FROM articles WHERE id=o.article_id) IS ? AND (${tagsSql})=?
          AND EXISTS(SELECT 1 FROM article_content_versions_p3 WHERE ${snapshotSql})
          AND EXISTS(SELECT 1 FROM e2e_approval_evidence_v1 WHERE approval_key=? AND evidence_document=? AND source_artifact_hash=?)
          AND EXISTS(SELECT 1 FROM e2e_search_apply_receipts_v1 r WHERE r.generation_id=o.generation_id
            AND r.fencing_token=? AND r.document_fingerprint=? AND r.fts_fingerprint=?)) THEN 1 ELSE 0 END)`).bind(
          `${token}:snapshot`,row.outbox_id,g.review_state??null,g.tag_snapshot,...columns.map(c=>version[c]??null),
          g.approval_key,approval.evidence_document,approval.source_artifact_hash,
          receipt.fencing_token,fingerprints.documentFingerprint,fingerprints.ftsFingerprint),
      core.prepare(`INSERT INTO e2e_verification_evidence_v1 (evidence_id,generation_id,result,verification_fence,applied_fence,
        document_fingerprint,fts_fingerprint,evidence_document,verified_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
          evidenceId,g.generation_id,resultKind,claimed.verification_fence,receipt.fencing_token,
          fingerprints.documentFingerprint,fingerprints.ftsFingerprint,canonicalJson(document),settled),
      core.prepare(`UPDATE e2e_generation_progress_v1 SET state=?,verified_at=?,verification_evidence_ref=?,
        last_error_code=NULL,updated_at=? WHERE generation_id=?`).bind(resultKind==="completed_verified"?resultKind:"blocked",settled,`core:e2e-verification:${evidenceId}`,settled,g.generation_id),
      core.prepare(`UPDATE e2e_search_repair_outbox_v1 SET status='verified',verified_at=?,evidence_ref=?,
        claimed_by=NULL,lease_expires_at=NULL,dispatch_owner=NULL,dispatch_token=NULL,dispatch_lease_expires_at=NULL,
        dispatch_fence=dispatch_fence+1,updated_at=? WHERE outbox_id=?`).bind(settled,`core:e2e-verification:${evidenceId}`,settled,row.outbox_id),
      core.prepare(`UPDATE e2e_verification_jobs_v1 SET status='verified',claimed_by=NULL,lease_expires_at=NULL,
        last_error_code=NULL,updated_at=? WHERE generation_id=?`).bind(settled,g.generation_id),
      core.prepare("DELETE FROM e2e_commit_guards_v1 WHERE token IN (?,?)").bind(token,`${token}:snapshot`)]);
    if (results.length!==7||results.some(r=>r.success===false||r.error)) throw new Error("e2e.verification_commit_failed");
    return {status:resultKind,evidenceId} as const;
  } catch (error) {
    const settled=clock(),code=error instanceof Error&&/^e2e\.[a-z_]+$/.test(error.message)?error.message:"e2e.verification_failed";
    const dead=Number(claimed.attempt_count)>=Number(claimed.max_attempts)
      || claimed.first_failure_at&&Date.parse(settled)-Date.parse(String(claimed.first_failure_at))>=7200000;
    const due=after(settled,Math.min(900,60*2**Math.min(Number(claimed.attempt_count)-1,10)));
    const ended=await settleFailure(settled,code,Boolean(dead),due,ownership,ownershipValues(settled));
    return {status:dead&&ended?"dead_letter":"retry",errorCode:code} as const;
  }
}
