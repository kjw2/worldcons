import type {D1RuntimeDatabase} from "../cloudflare/d1/runtime-binding";
import {approvalSourceMetadata} from "../cloudflare/core-write/authority";
import {approvalIdentity,HUMAN_APPROVAL_POLICY} from "../cloudflare/e2e/contracts";
import {HumanApprovalBlocked,protectedSourceRequired,readHumanReviewSnapshot} from "../cloudflare/e2e/manual-approval";
import {allPredicates} from "../cloudflare/e2e/sql-predicates";
import type {GenerationRow} from "../cloudflare/e2e/generation-state";
export async function verifyHumanPreview(core:D1RuntimeDatabase,articleId:string,expectedHash?:string) {
  const current=await readHumanReviewSnapshot(core,{articleId});
  if((await protectedSourceRequired(core,articleId)||expectedHash)&&current.identity.approvalSnapshotHash!==expectedHash)throw new HumanApprovalBlocked("human_approval.snapshot_stale");
  return current;
}
export async function approvalPreview(core:D1RuntimeDatabase,input:{articleId?:string;slug?:string}) {
  const {article,identity}=await readHumanReviewSnapshot(core,input);
  return {articleId:String(article.id),slug:String(article.slug),approvalSnapshotHash:identity.approvalSnapshotHash,requiresProtectedApproval:await protectedSourceRequired(core,String(article.id)),
    koreanTitle:String(article.korean_title??""),originalTitle:String(article.original_title??""),canonicalUrl:String(article.canonical_url??""),cleanedText:String(article.cleaned_text??""),
    summaryJson:typeof article.summary_json==="string"?JSON.parse(article.summary_json):article.summary_json,fetchedAt:article.fetched_at};
}
/** Apply only derived review metadata to the exact row that was shown, then return its expected approved checksum. */
export async function updateReviewedMetadata(core:D1RuntimeDatabase,before:GenerationRow,metadata:unknown,reviewState:string,now:string) {
  const keys=Object.keys(before);if(keys.some(k=>!/^[a-z_][a-z0-9_]*$/.test(k))||keys.length+5>100)throw new HumanApprovalBlocked("human_approval.guard_budget");
  const serialized=typeof metadata==="string"?metadata:JSON.stringify(metadata);
  const sql="UPDATE articles SET status='summarized',summarized_at=COALESCE(summarized_at,?),source_metadata=?,error_metadata=NULL,error_class=NULL,error_context=NULL,review_state=?,updated_at=? WHERE "+allPredicates(keys.map(k=>'"'+k+'" IS ?'));
  const result=await core.prepare(sql).bind(now,serialized,reviewState,now,...keys.map(k=>before[k]??null)).run?.();
  if(!result||result.success===false||result.error||Number(result.meta?.changes)!==1)throw new HumanApprovalBlocked("human_approval.snapshot_stale");
  return (await approvalIdentity(String(before.id),{...before,source_metadata:approvalSourceMetadata(serialized,true)},HUMAN_APPROVAL_POLICY)).approvalSnapshotHash;
}
