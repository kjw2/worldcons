import {canonicalOfficialArticleUrl} from "@/lib/search/official-case-url";
import { SummarySchema } from "@/lib/ai/schema";
import { canonicalJson } from "@/lib/backfill/canonical-json";
import { canonicalArticleCaseNumber, normalizeCaseNumber } from "@/lib/search/case-number";
import { approvalSourceMetadata } from "../core-write/authority";
import type { D1RuntimeDatabase } from "../d1/runtime-binding";
import { APPROVAL_HASH_SCHEMA,approvalIdentity, STAGED_APPROVAL_POLICY, type E2EApprovalContext } from "./contracts";
import { e2eRows, type GenerationRow } from "./generation-state";

export interface AutomaticApprovalSource {
  articleId:string; sourceKey:string; candidateId:string; pipelineRunId:string;
  sourceArtifactRef:string; sourceArtifactHash:string; cleanedSourceText:string;
  candidateUrl:string; canonicalUrl:string; candidateTitle:string; now:string;
}
export class AutomaticApprovalBlocked extends Error {}
function blocked():never { throw new AutomaticApprovalBlocked("e2e.automatic_approval_review_required"); }
function object(value:unknown):GenerationRow {
  if (typeof value==="string") { try { return object(JSON.parse(value)); } catch { return blocked(); } }
  return value&&typeof value==="object"&&!Array.isArray(value)?value as GenerationRow:{};
}
/** Existing source/summary policy signals are gates, not a legal-meaning re-review. */
export async function recordAutomaticApproval(core:D1RuntimeDatabase,input:AutomaticApprovalSource):Promise<E2EApprovalContext> {
  const article=(await e2eRows(core,"SELECT * FROM articles WHERE id=?",input.articleId))[0];
  if (!article) return blocked();
  const host=input.sourceKey==="fr-conseil-constitutionnel"?"www.conseil-constitutionnel.fr"
    :input.sourceKey==="es-tribunal-constitucional"?"hj.tribunalconstitucional.es":null;
  if (!host||article.source_key!==input.sourceKey||canonicalOfficialArticleUrl(input.sourceKey,String(article.canonical_url))!==canonicalOfficialArticleUrl(input.sourceKey,input.canonicalUrl)
    || typeof article.cleaned_text!=="string"||article.cleaned_text!==input.cleanedSourceText||input.cleanedSourceText.length<2000
    || article.status!=="summarized"||article.translation_status!=="translated"
    || article.lifecycle_collection_state!=="source_text_ready"||article.lifecycle_processing_state!=="complete"
    || !["unreviewed","approved"].includes(String(article.lifecycle_review_state))||article.lifecycle_attention_state!=="clear"
    || ["needs_review","needs_triage","closed_private","rejected","blocked"].includes(String(article.review_state??"").toLowerCase())) return blocked();
  for (const value of [input.candidateUrl,input.canonicalUrl]) {
    let url:URL; try { url=new URL(value); } catch { return blocked(); }
    if (url.protocol!=="https:"||url.hostname!==host||url.username||url.password||url.hash||(url.port&&url.port!=="443")) return blocked();
  }
  const metadata=object(article.source_metadata),collection=object(metadata.collection??object(metadata.case).collection);
  if (collection.publishable!==true||collection.sourceTextAvailable!==true||collection.sourceUrlVerified!==true
    || collection.robotsDisallowed===true||collection.strategy==="seed"||object(metadata.collectionSafety).publishable===false
    || metadata.sourceTextStatus==="not_available"||[true,1,"1"].includes(object(metadata.catalog).sourceOnly as never)) return blocked();
  if(input.sourceKey==="es-tribunal-constitucional") {
    const canonical=canonicalOfficialArticleUrl(input.sourceKey,String(article.canonical_url));
    const owner=(await e2eRows(core,"SELECT id FROM articles WHERE source_key=? AND (canonical_url IN (?,?) OR instr(canonical_url,?)=1 OR instr(canonical_url,?)=1) ORDER BY created_at,id LIMIT 1",input.sourceKey,canonical,canonical.replace("/HJ/es/","/es/"),canonical+"?",canonical.replace("/HJ/es/","/es/")+"?"))[0];
    if(owner&&owner.id!==article.id)throw new AutomaticApprovalBlocked("e2e.duplicate_official_case");
  }
  const parsed=SummarySchema.safeParse(object(article.summary_json));
  if (!parsed.success||!/[가-힣]/.test(String(article.korean_title))||!/[가-힣]/.test(parsed.data.koreanTitle)
    || !parsed.data.summary.coreSummary.length||parsed.data.summary.coreSummary.some(text=>!/[가-힣]/.test(text))
    || parsed.data.riskFlags.length) return blocked();
  if (!input.candidateId.startsWith("native:")||!input.pipelineRunId||!input.sourceArtifactRef.startsWith("stages/ingest-crawl/")||!/^[a-f0-9]{64}$/.test(input.sourceArtifactHash)) return blocked();
  const candidateCase=normalizeCaseNumber(input.sourceKey,input.candidateTitle);
  // Old Spanish list artifacts omitted the authoritative case number. Fill it only
  // from a matching official title and the exact already-validated source snapshot.
  let caseNumber=canonicalArticleCaseNumber({sourceKey:input.sourceKey,originalTitle:String(article.original_title),metadata});
  if(!caseNumber&&input.sourceKey==="es-tribunal-constitucional"&&candidateCase
    &&candidateCase===normalizeCaseNumber(input.sourceKey,String(article.original_title))) {
    const updated=JSON.stringify({...metadata,caseNumber:candidateCase});
    const result=await core.prepare("UPDATE articles SET source_metadata=? WHERE id=? AND source_key=? AND canonical_url=? AND cleaned_text IS ? AND summary_json IS ? AND source_metadata IS ? AND original_title IS ? AND fetched_at IS ?")
      .bind(updated,input.articleId,input.sourceKey,article.canonical_url,article.cleaned_text,article.summary_json,article.source_metadata,article.original_title,article.fetched_at??null).run?.();
    if(!result||result.success===false||result.error||Number(result.meta?.changes)!==1)throw Error("e2e.case_metadata_snapshot_changed");
    article.source_metadata=updated;caseNumber=candidateCase;
  }
  if (!caseNumber||caseNumber!==candidateCase||!input.candidateId.startsWith("native:")||!input.pipelineRunId
    || !input.sourceArtifactRef.startsWith("stages/ingest-crawl/")||!/^[a-f0-9]{64}$/.test(input.sourceArtifactHash)) return blocked();
  const identity=await approvalIdentity(input.articleId,{...article,source_metadata:approvalSourceMetadata(article.source_metadata,true)},STAGED_APPROVAL_POLICY);
  const evidenceRef=`core:e2e-approval:${identity.approvalKey}`;
  const document={schema:"worldcons.automatic-approval.v1",...identity,articleId:input.articleId,policyVersion:STAGED_APPROVAL_POLICY,
    candidateId:input.candidateId,pipelineRunId:input.pipelineRunId,caseNumber,sourceArtifactRef:input.sourceArtifactRef,
    sourceArtifactHash:input.sourceArtifactHash,canonicalUrl:input.canonicalUrl,checks:{sourceTextMatches:true,
      officialHost:true,publicPermission:true,translationPersisted:true,summarySchema:true,noRiskFlags:true,noReviewBlock:true},observedAt:input.now};
  await e2eRows(core,`INSERT INTO e2e_approval_evidence_v1 (approval_key,article_id,approval_snapshot_hash,source_content_hash,
    policy_version,evidence_ref,source_artifact_ref,source_artifact_hash,discovery_candidate_id,pipeline_run_id,evidence_document,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(approval_key) DO NOTHING`,identity.approvalKey,input.articleId,
    identity.approvalSnapshotHash,identity.sourceContentHash,STAGED_APPROVAL_POLICY,evidenceRef,input.sourceArtifactRef,
    input.sourceArtifactHash,input.candidateId,input.pipelineRunId,canonicalJson(document),input.now);
  const saved=(await e2eRows(core,"SELECT * FROM e2e_approval_evidence_v1 WHERE approval_key=?",identity.approvalKey))[0];
  if (!saved||saved.article_id!==input.articleId||saved.approval_snapshot_hash!==identity.approvalSnapshotHash
    || saved.source_content_hash!==identity.sourceContentHash||saved.policy_version!==STAGED_APPROVAL_POLICY) return blocked();
  return {mode:"automatic",hashSchema:APPROVAL_HASH_SCHEMA,policyVersion:STAGED_APPROVAL_POLICY,evidenceRef:String(saved.evidence_ref),
    sourceEvidenceRef:String(saved.source_artifact_ref),pipelineRunId:String(saved.pipeline_run_id),discoveryCandidateId:String(saved.discovery_candidate_id)};
}
