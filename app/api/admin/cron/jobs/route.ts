import { NextResponse } from "next/server";
import { isAuthorizedSecretRequest } from "@/lib/utils/auth";
export const dynamic="force-dynamic"; export const revalidate=0;
export function GET(request:Request){if(!isAuthorizedSecretRequest(request))return NextResponse.json({error:"Unauthorized"},{status:401});return NextResponse.json({mode:"cloudflare_scheduler",managedBy:"worldcons-ingest",message:"Admin job draining is owned by the Cloudflare Workers Cron/Workflow scheduler."});}
