import type {D1RuntimeDatabase} from "../../../lib/cloudflare/d1/runtime-binding";
import {reserveDiscoveryCandidates,type DiscoveryBucket} from "../../../lib/cloudflare/ingest-stages/discovery-coverage";
import {ingestStageGateFromEnvironment,isIngestStageEnabled} from "../../../lib/cloudflare/ingest-stages/flags";
export interface DiscoveryCoverageEnvironment {
  WORLDCONS_INGEST:D1RuntimeDatabase;WORLDCONS_RAW:DiscoveryBucket;
  WORLDCONS_E2E_STAGED_APPROVAL_ENABLED?:string;WORLDCONS_E2E_STAGED_SOURCES?:string;
}
export async function runDiscoveryCoverageScheduled(env:DiscoveryCoverageEnvironment) {
  if(env.WORLDCONS_E2E_STAGED_APPROVAL_ENABLED!=="true")return {skipped:true,reason:"disabled"};
  const gate=ingestStageGateFromEnvironment(env as unknown as Record<string,string|undefined>);
  if(!isIngestStageEnabled(gate,"discovery")||!isIngestStageEnabled(gate,"crawl"))return {skipped:true,reason:"stage_disabled"};
  const sources=[...new Set((env.WORLDCONS_E2E_STAGED_SOURCES??"").split(",").map(s=>s.trim()).filter(Boolean))];
  if(!sources.length||sources.some(s=>!["fr-conseil-constitutionnel","es-tribunal-constitucional"].includes(s)))throw Error("discovery.sources_invalid");
  try {
    const health=await reserveDiscoveryCandidates(env.WORLDCONS_INGEST,env.WORLDCONS_RAW,{sources,now:new Date().toISOString(),clock:()=>new Date().toISOString(),owner:"discovery-minute",limit:20});
    console[health.requiresAttention?"error":"log"](JSON.stringify({event:"ingest_discovery_reservations",...health}));return {skipped:false,...health};
  } catch(error) {
    console.error(JSON.stringify({event:"ingest_discovery_reservation_failed",reason:error instanceof Error?error.message:"unavailable"}));
    return {skipped:true,reason:"unavailable"};
  }
}
