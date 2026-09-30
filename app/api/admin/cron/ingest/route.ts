import { NextResponse } from "next/server";
import { isAuthorizedSecretRequest } from "@/lib/utils/auth";
export const dynamic="force-dynamic"; export const revalidate=0;
export function GET(request:Request){if(!isAuthorizedSecretRequest(request))return NextResponse.json({error:"Unauthorized"},{status:401});return NextResponse.json({complete:true,mode:"cloudflare_scheduler",managedBy:"worldcons-ingest",message:"Scheduled ingestion is owned by Cloudflare Workers Cron/Workflow."});}
