import {canonicalOfficialArticleUrl} from "@/lib/search/official-case-url";
import {SummarySchema} from "@/lib/ai/schema";
import {canonicalJson} from "@/lib/backfill/canonical-json";
import {approvalSourceMetadata} from "../core-write/authority";
import type {D1RuntimeDatabase} from "../d1/runtime-binding";
import {APPROVAL_HASH_SCHEMA,approvalIdentity,HUMAN_APPROVAL_POLICY,REMOVAL_AUTHORITY_POLICY,sha256Canonical,type E2EApprovalContext} from "./contracts";
import {e2eRows,hasE2ETable,type GenerationRow} from "./generation-state";
export class HumanApprovalBlocked extends Error {}
function object(value:unknown):GenerationRow {if(typeof value==="string"){try{return object(JSON.parse(value));}catch{return {};}}return value&&typeof value==="object"&&!Array.isArray(value)?value as GenerationRow:{};}
export async function protectedSourceRequired(core:D1RuntimeDatabase,articleId:string) {
  if(await hasE2ETable(core,"e2e_generation_heads_v1")&&(await e2eRows(core,"SELECT article_id FROM e2e_generation_heads_v1 WHERE article_id=?",articleId)).length)return true;
  return await hasE2ETable(core,"e2e_source_policies_v1")&&(await e2eRows(core,"SELECT a.id FROM articles a JOIN e2e_source_policies_v1 p ON p.source_key=a.source_key WHERE a.id=? AND p.required=1",articleId)).length>0;
}
export async function readHumanReviewSnapshot(core:D1RuntimeDatabase,input:{articleId?:string;slug?:string}) {
  const article=(await e2eRows(core,"SELECT * FROM articles WHERE "+(input.articleId?"id=?":"slug=?"),input.articleId??input.slug))[0];
  if(!article)throw new HumanApprovalBlocked("human_approval.not_found");
  const snapshot={...article,source_metadata:approvalSourceMetadata(article.source_metadata,true)};
  const identity=await approvalIdentity(String(article.id),snapshot,HUMAN_APPROVAL_POLICY);
  return {article,snapshot,identity};
}
async function persist(core:D1RuntimeDatabase,articleId:string,snapshot:GenerationRow,policy:string,mode:"human"|"automatic",document:GenerationRow,now:string):Promise<E2EApprovalContext> {
  const identity=await approvalIdentity(articleId,snapshot,policy),sourceArtifact={schema:"worldcons.reviewed-source.v1",articleId,canonicalUrl:snapshot.canonical_url,cleanedText:snapshot.cleaned_text??null};
  const hash=await sha256Canonical(sourceArtifact),ref="core:e2e-reviewed-source:"+hash;
  const candidateId="manual:"+articleId,pipelineRunId="review:"+await sha256Canonical(document.requestId??identity.approvalKey);
  const evidenceRef="core:e2e-approval:"+identity.approvalKey;
  document=Object.fromEntries(Object.entries(document).filter(([,value])=>value!==undefined));
  const proof={...document,...identity,articleId,policyVersion:policy,sourceArtifact,sourceArtifactHash:hash,sourceArtifactRef:ref,candidateId,pipelineRunId,observedAt:now};
  await e2eRows(core,"INSERT INTO e2e_approval_evidence_v1(approval_key,article_id,approval_snapshot_hash,source_content_hash,policy_version,evidence_ref,source_artifact_ref,source_artifact_hash,discovery_candidate_id,pipeline_run_id,evidence_document,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(approval_key) DO NOTHING",
    identity.approvalKey,articleId,identity.approvalSnapshotHash,identity.sourceContentHash,policy,evidenceRef,ref,hash,candidateId,pipelineRunId,canonicalJson(proof),now);
  const saved=(await e2eRows(core,"SELECT * FROM e2e_approval_evidence_v1 WHERE approval_key=?",identity.approvalKey))[0];
  if(!saved||saved.approval_snapshot_hash!==identity.approvalSnapshotHash||saved.source_content_hash!==identity.sourceContentHash||saved.policy_version!==policy)throw new HumanApprovalBlocked("human_approval.evidence_mismatch");
  return {mode,hashSchema:APPROVAL_HASH_SCHEMA,policyVersion:policy,evidenceRef:String(saved.evidence_ref),sourceEvidenceRef:String(saved.source_artifact_ref),pipelineRunId:String(saved.pipeline_run_id),discoveryCandidateId:String(saved.discovery_candidate_id)};
}
/** Only authenticated human controllers call this; an exact preview checksum is mandatory. */
export async function recordHumanApproval(core:D1RuntimeDatabase,input:{articleId:string;actorId:string;expectedSnapshotHash:string;note?:string;requestId?:string;now:string}) {
  const reviewed=await readHumanReviewSnapshot(core,input),article=reviewed.article;
  if(!input.actorId||!input.expectedSnapshotHash||reviewed.identity.approvalSnapshotHash!==input.expectedSnapshotHash)throw new HumanApprovalBlocked("human_approval.snapshot_stale");
  const metadata=object(article.source_metadata),collection=object(metadata.collection??{}),safety=object(metadata.collectionSafety??{}),catalog=object(metadata.catalog??{});
  const summary=SummarySchema.safeParse(object(article.summary_json));
  const hosts:Record<string,string>={"fr-conseil-constitutionnel":"www.conseil-constitutionnel.fr","es-tribunal-constitucional":"hj.tribunalconstitucional.es","de-bverfg":"www.bundesverfassungsgericht.de","us-scotus":"www.supremecourt.gov"};
  let url:URL;try{url=new URL(String(article.canonical_url));}catch{throw new HumanApprovalBlocked("human_approval.source_invalid");}
  if(url.protocol!=="https:"||url.hostname!==hosts[String(article.source_key)]||url.username||url.password||url.hash||(url.port&&url.port!=="443")
    ||collection.publishable!==true||collection.sourceTextAvailable!==true||collection.sourceUrlVerified!==true||collection.robotsDisallowed===true||collection.strategy==="seed"||safety.publishable===false||[true,1,"1"].includes(catalog.sourceOnly as never)||metadata.sourceTextStatus==="not_available"
    ||String(article.cleaned_text??"").trim().length<500||!summary.success||!/[가-힣]/.test(String(article.korean_title))
    ||["needs_review","needs_triage","closed_private","rejected","blocked"].includes(String(article.review_state)))throw new HumanApprovalBlocked("human_approval.source_or_summary_invalid");
  if(article.source_key==="es-tribunal-constitucional") {
    const canonical=canonicalOfficialArticleUrl(String(article.source_key),String(article.canonical_url));
    const owner=(await e2eRows(core,"SELECT id FROM articles WHERE source_key=? AND (canonical_url IN (?,?) OR instr(canonical_url,?)=1 OR instr(canonical_url,?)=1) ORDER BY created_at,id LIMIT 1",article.source_key,canonical,canonical.replace("/HJ/es/","/es/"),canonical+"?",canonical.replace("/HJ/es/","/es/")+"?"))[0];
    if(owner&&owner.id!==article.id)throw new HumanApprovalBlocked("human_approval.duplicate_official_case");
  }
  if(summary.data.riskFlags.length&&!input.note?.trim())throw new HumanApprovalBlocked("human_approval.risk_note_required");
  return persist(core,input.articleId,reviewed.snapshot,HUMAN_APPROVAL_POLICY,"human",{schema:"worldcons.human-approval.v1",actorId:input.actorId,note:input.note??null,requestId:input.requestId,
    checks:{reviewedExactSnapshot:true,officialHost:true,publicPermission:true,summarySchema:true,riskFlagsAcknowledged:summary.data.riskFlags.length===0||Boolean(input.note?.trim())},riskFlags:summary.data.riskFlags},input.now);
}
/** Index removal authorizes privacy, never publication or legal meaning of the body. */
export function recordRemovalAuthority(core:D1RuntimeDatabase,input:{articleId:string;snapshot:GenerationRow;actorType:string;actorId?:string|null;requestId:string;targetState:string;now:string}) {
  if(input.targetState==="published")throw Error("removal_authority.cannot_publish");
  return persist(core,input.articleId,input.snapshot,REMOVAL_AUTHORITY_POLICY,"automatic",{schema:"worldcons.removal-authority.v1",actorType:input.actorType,actorId:input.actorId??null,
    requestId:input.requestId,targetState:input.targetState,noPublicApproval:true,checks:{exactSnapshot:true,removalOnly:true}},input.now);
}
