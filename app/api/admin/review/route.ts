import { NextResponse } from "next/server";
import { runD1AdminReviewAction } from "@/lib/admin/d1-review";
import { recordAdminSiteEvent } from "@/lib/analytics/events";
import { invalidatePublicContentCaches } from "@/lib/public-content-cache";
import { parseAdminReviewBody } from "@/lib/security/admin-api-validation";
import {HumanApprovalBlocked} from "@/lib/cloudflare/e2e/manual-approval";
import { adminSessionIdentityFromRequest, adminMutationAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic="force-dynamic"; export const revalidate=0;
export async function POST(request:Request){
  const auth=adminMutationAuthFailureStatus(request); if(auth)return NextResponse.json({error:auth===401?"Unauthorized":"Forbidden"},{status:auth});
  const parsed=parseAdminReviewBody(await request.json().catch(()=>({}))); if(!parsed.ok)return NextResponse.json({error:"Invalid admin review request",detail:parsed.error},{status:400});
  let result;
  try{result=await runD1AdminReviewAction(parsed.data,adminSessionIdentityFromRequest(request));}
  catch(error){if(error instanceof HumanApprovalBlocked)return NextResponse.json({error:"검토 내용이 바뀌었거나 승인 조건을 충족하지 않습니다. 자료를 다시 확인해 주세요."},{status:error.message.includes("session_required")?403:409});throw error;}
  if(result.status==="unsupported_provider")return NextResponse.json({review:result},{status:400});
  if(result.status==="published"||result.status==="closed_private")invalidatePublicContentCaches({articleSlug:parsed.data.slug});
  await recordAdminSiteEvent({eventType:"admin_review_action",path:"/api/admin/review",articleId:parsed.data.articleId,articleSlug:parsed.data.slug,metadata:{action:parsed.data.action,provider:parsed.data.provider,model:parsed.data.model,status:result.status}},request.headers).catch(()=>null);
  return NextResponse.json({review:result},{status:result.status==="not_found"?404:result.status==="queued"?202:200});
}
