import { articleLifecycleService } from "@/lib/article-lifecycle/service";
import { articlePublicationService } from "@/lib/article-publication/service";
import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import { buildAdminJobIdempotencyKey, createAdminJob } from "@/lib/db/admin-jobs";
import { MIN_PUBLISHABLE_TEXT_LENGTH } from "@/lib/ingest/publishability";
import type { AdminReviewBody } from "@/lib/security/admin-api-validation";

type Row = Record<string, unknown>;
function parsed(value: unknown) { if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; if (typeof value === "string") { try { const v: unknown = JSON.parse(value); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; } } return {}; }
function text(row: Row, key: string) { return typeof row[key] === "string" ? row[key] as string : null; }

async function article(input: Pick<AdminReviewBody,"articleId"|"slug">) {
  const core=getRuntimeD1Binding("worldcons_core"); if(!core) throw new Error("worldcons_core D1 binding is not configured.");
  const where=input.articleId?"a.id=?":"a.slug=?", value=input.articleId??input.slug!;
  const result=await core.prepare(`SELECT a.id,a.slug,a.source_key,a.status,a.cleaned_text,a.summary_json,a.source_metadata,a.review_state,a.updated_at,p.state AS publication_state,p.revision AS publication_revision,p.version_id,h.current_revision,h.current_version_id FROM articles a LEFT JOIN article_publications_p3 p ON p.article_id=a.id LEFT JOIN article_version_heads_p3 h ON h.article_id=a.id WHERE ${where} LIMIT 1`).bind(value).all<Row>();
  if(result.success===false||result.error) throw new Error(result.error||"admin_review.d1_read_failed");
  return { core, row: result.results?.[0] ?? null };
}

function reviewMetadata(row:Row,decision:string,note?:string,collectionOverrides:Record<string,unknown>={},extras:Record<string,unknown>={}) {
  const metadata=parsed(row.source_metadata), collection=parsed(metadata.collection), history=Array.isArray(metadata.reviewHistory)?metadata.reviewHistory:[], reviewedAt=new Date().toISOString();
  const review={decision,note:note?.trim()||undefined,reviewedAt,previousStatus:text(row,"status"),...extras};
  return {...metadata,collection:{...collection,...collectionOverrides},review,reviewHistory:[...history.slice(-19),review]};
}

async function lifecycle(articleId:string, reviewState:"approved_for_processing"|"approved"|"closed_private", reasonCode:string) {
  const current=await articleLifecycleService.get(articleId); if(!current.ok) return;
  await articleLifecycleService.transition({articleId,expectedRevision:current.data.revision,idempotencyKey:`admin-review:${articleId}:${current.data.revision}:${reasonCode}`,actorType:"admin",actorId:"admin-review",source:"admin.review",reasonCode,reviewState,attention:{operation:"keep"}});
}

async function queue(jobType:"ingest"|"retry-summary", row:Row, options:Record<string,unknown>) {
  const articleId=text(row,"id")!, articleSlug=text(row,"slug")??undefined, sourceKey=text(row,"source_key")??undefined;
  const idempotencyKey=buildAdminJobIdempotencyKey({jobType,sourceKey,articleId,articleSlug,options});
  const result=await createAdminJob({jobType,sourceKey,articleId,articleSlug,priority:jobType==="retry-summary"?20:10,idempotencyKey,options});
  if(!result.ok) throw new Error(result.error);
  return {id:result.data.job.id,status:result.data.job.status,created:result.data.created};
}

async function publication(row:Row,targetState:"published"|"withdrawn",reason:string) {
  const articleId=text(row,"id")!;
  const snapshot=await articlePublicationService.getSnapshot(articleId); if(!snapshot.ok) return null;
  const versionId=targetState==="published"?text(row,"current_version_id"):text(row,"version_id"); if(!versionId) return null;
  const result=await articlePublicationService.transition({articleId,expectedVersionRevision:snapshot.data.versionRevision,expectedPublicationRevision:snapshot.data.publicationRevision,idempotencyKey:`admin-review-publication:${articleId}:${snapshot.data.publicationRevision}:${targetState}`,targetState,versionId,actorType:"human",actorId:"admin-review",reason,provenanceActorType:"human",provenanceActorId:"admin-review"});
  if(!result.ok) throw new Error(`admin_review.publication:${result.error.code}`); return result.data;
}

export async function runD1AdminReviewAction(input:AdminReviewBody) {
  const {core,row}=await article(input); if(!row) return {mode:"database" as const,status:"not_found" as const,reason:"자료를 찾을 수 없습니다."};
  const id=text(row,"id")!, slug=text(row,"slug")??undefined, note=input.note;
  if(input.action==="retry-summary"||input.action==="resummarize-with-model") {
    if(input.action==="resummarize-with-model"&&input.provider&&input.provider!=="gemini") return {mode:"database" as const,status:"unsupported_provider" as const,reason:"Cloudflare 요약 실행기는 현재 Gemini provider를 사용합니다."};
    const job=await queue("retry-summary",row,{action:"retry-summary",articleId:id,slug,model:input.model??null,provider:input.provider??"gemini"});
    return {mode:"database" as const,action:input.action,status:"queued" as const,job};
  }
  if(input.action==="retry-source-ingest") {
    const job=await queue("ingest",row,{action:"ingest",sourceKey:text(row,"source_key"),articleId:id,slug,limit:20,refreshExisting:true});
    return {mode:"database" as const,action:input.action,status:"queued" as const,job};
  }
  if(input.action==="approve-and-summarize") {
    const cleaned=text(row,"cleaned_text")??""; if(cleaned.trim().length<MIN_PUBLISHABLE_TEXT_LENGTH) return {mode:"database" as const,action:input.action,status:"skipped" as const,reason:`추출 본문이 ${MIN_PUBLISHABLE_TEXT_LENGTH}자 미만이라 요약 승인 전에 원문 수집을 다시 해야 합니다.`};
    const now=new Date().toISOString(), metadata=reviewMetadata(row,"approved_for_summary",note,{publishable:true,sourceTextAvailable:true,sourceUrlVerified:true,robotsDisallowed:false,confidence:"human_reviewed",reason:`Human review approved summarization and publication eligibility (${cleaned.trim().length} chars).`});
    const write=await core.prepare("UPDATE articles SET status='cleaned',source_metadata=?,error_metadata=NULL,error_class=NULL,error_context=NULL,review_state='approved_for_summary',updated_at=? WHERE id=?").bind(JSON.stringify(metadata),now,id).run?.(); if(!write||write.success===false||write.error) throw new Error(write?.error||"admin_review.d1_write_failed");
    await lifecycle(id,"approved_for_processing","review.approved_for_summary");
    const job=await queue("retry-summary",row,{action:"retry-summary",articleId:id,slug});
    return {mode:"database" as const,action:input.action,status:"queued" as const,job};
  }
  if(input.action==="publish-reviewed") {
    if(!row.summary_json) return {mode:"database" as const,action:input.action,status:"skipped" as const,reason:"요약 JSON이 없어 바로 공개할 수 없습니다. 먼저 요약을 실행해야 합니다."};
    const now=new Date().toISOString(), metadata=reviewMetadata(row,"published",note,{publishable:true,sourceTextAvailable:Boolean((text(row,"cleaned_text")??"").trim()),sourceUrlVerified:true,robotsDisallowed:false,confidence:"human_reviewed",reason:"Human review approved publication."});
    const write=await core.prepare("UPDATE articles SET status='summarized',summarized_at=COALESCE(summarized_at,?),source_metadata=?,error_metadata=NULL,error_class=NULL,error_context=NULL,review_state='published',updated_at=? WHERE id=?").bind(now,JSON.stringify(metadata),now,id).run?.(); if(!write||write.success===false||write.error) throw new Error(write?.error||"admin_review.d1_write_failed");
    await lifecycle(id,"approved","review.published"); await publication(row,"published",note?.trim()||"Human review approved publication.");
    return {mode:"database" as const,action:input.action,status:"published" as const};
  }
  const now=new Date().toISOString(), metadata=reviewMetadata(row,"closed_private",note,{publishable:false,confidence:"human_reviewed",reason:note?.trim()||"Human review closed this item as private."});
  const write=await core.prepare("UPDATE articles SET status='needs_review',source_metadata=?,error_metadata=NULL,error_class=NULL,error_context=NULL,review_state='closed_private',updated_at=? WHERE id=?").bind(JSON.stringify(metadata),now,id).run?.(); if(!write||write.success===false||write.error) throw new Error(write?.error||"admin_review.d1_write_failed");
  await lifecycle(id,"closed_private","review.closed_private"); if(text(row,"publication_state")==="published") await publication(row,"withdrawn",note?.trim()||"Human review closed this item as private.");
  return {mode:"database" as const,action:input.action,status:"closed_private" as const};
}
