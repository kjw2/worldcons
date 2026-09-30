import { NextResponse } from "next/server";
import { parseAdminJobRunBody } from "@/lib/security/admin-api-validation";
import { adminMutationAuthFailureStatus } from "@/lib/utils/auth";
export const dynamic="force-dynamic"; export const revalidate=0;
export function GET(){return new Response(null,{status:405,headers:{allow:"POST"}});}
export async function POST(request:Request){const auth=adminMutationAuthFailureStatus(request);if(auth)return NextResponse.json({error:auth===401?"Unauthorized":"Forbidden"},{status:auth});const parsed=parseAdminJobRunBody(await request.json().catch(()=>({})));if(!parsed.ok)return NextResponse.json({error:"Invalid admin job worker request",detail:parsed.error},{status:400});return NextResponse.json({mode:"cloudflare_scheduler",managedBy:"worldcons-ingest",requested:parsed.data,message:"Manual drain execution inside the app Worker is disabled; Cloudflare Workflow owns job draining."},{status:202});}
