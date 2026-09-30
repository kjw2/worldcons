import { NextResponse } from "next/server";
import { buildAdminIngestJobContext, validateAdminIngestJobContext } from "@/lib/admin/admin-ingest-contract";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import { buildAdminJobIdempotencyKey, createAdminJob, type AdminJobRecord } from "@/lib/db/admin-jobs";
import { CollectionPausedError, assertCollectionCanStart } from "@/lib/masterdash/store";
import { parseAdminIngestBody } from "@/lib/security/admin-api-validation";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic="force-dynamic"; export const revalidate=0; export const maxDuration=30;
function publicJob(job:AdminJobRecord){return {id:job.id,status:job.status,jobType:job.jobType,sourceKey:job.sourceKey,articleId:job.articleId,articleSlug:job.articleSlug,requestedAt:job.requestedAt};}

export async function POST(request:Request){
  const auth=adminMutationAuthFailureStatus(request); if(auth)return NextResponse.json({error:auth===401?"Unauthorized":"Forbidden"},{status:auth});
  const parsed= parseAdminIngestBody(await request.json().catch(()=>({}))); if(!parsed.ok)return NextResponse.json({error:"Invalid admin ingest request",detail:parsed.error},{status:400});
  const context=buildAdminIngestJobContext(parsed.data); try{validateAdminIngestJobContext(context);}catch(e){return NextResponse.json({error:e instanceof Error?e.message:String(e)},{status:400});}
  if(context.shouldIngest){try{await assertCollectionCanStart();}catch(e){const paused=e instanceof CollectionPausedError;return NextResponse.json({error:paused?e.message:"Collection control state is unavailable; no new collection was started."},{status:paused?e.status:503});}}
  const idempotencyKey=buildAdminJobIdempotencyKey({jobType:context.action,sourceKey:context.sourceKey,articleId:context.articleId,articleSlug:context.slug,options:context.jobOptions});
  const queued=await createAdminJob({jobType:context.action,sourceKey:context.sourceKey,articleId:context.articleId,articleSlug:context.slug,priority:context.action==="retry-summary"?20:context.action==="summarize"?10:0,idempotencyKey,options:context.jobOptions});
  if(!queued.ok)return NextResponse.json({error:"Cloudflare admin job queue is unavailable.",detail:queued.error,requested:context.requestedOptions,mode:"queue_unavailable"},{status:503});
  await recordAdminSiteEvent({eventType:"admin_action",path:"/api/admin/ingest",sourceKey:context.sourceKey,articleId:context.articleId,articleSlug:context.slug,metadata:{...context.auditMetadata,result:"queued",jobId:queued.data.job.id,jobType:queued.data.job.jobType,created:queued.data.created}},request.headers).catch(()=>null);
  return NextResponse.json({requested:context.requestedOptions,mode:"queued",job:publicJob(queued.data.job),created:queued.data.created},{status:202});
}
