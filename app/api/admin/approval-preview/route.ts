import {NextResponse} from "next/server";
import {adminSessionIdentityFromRequest} from "@/lib/utils/auth";
import {getRuntimeD1Binding} from "@/lib/cloudflare/d1/runtime-binding";
import {approvalPreview} from "@/lib/admin/e2e-human-review";
export const dynamic="force-dynamic";export const revalidate=0;
export async function GET(request:Request) {
  if(!adminSessionIdentityFromRequest(request))return NextResponse.json({error:"Unauthorized"},{status:401});
  const url=new URL(request.url),articleId=url.searchParams.get("articleId")??undefined,slug=url.searchParams.get("slug")??undefined;
  if((!articleId&&!slug)||(articleId&&!/^[a-f0-9-]{36}$/i.test(articleId))||(slug&&!/^[a-z0-9-]{1,200}$/.test(slug)))return NextResponse.json({error:"Invalid article"},{status:400});
  const core=getRuntimeD1Binding("worldcons_core");if(!core)return NextResponse.json({error:"Unavailable"},{status:503});
  try{return NextResponse.json({preview:await approvalPreview(core,{articleId,slug})},{headers:{"cache-control":"no-store"}});}
  catch{return NextResponse.json({error:"자료를 찾을 수 없거나 검토 원문을 읽을 수 없습니다."},{status:404,headers:{"cache-control":"no-store"}});}
}
