import {isSearchRepairMessage} from "../../../lib/cloudflare/e2e/search-repair-dispatcher";
import type { D1RuntimeDatabase } from "../../../lib/cloudflare/d1/runtime-binding";
import { consumeSearchRepair } from "../../../lib/cloudflare/e2e/search-repair-consumer";
import { verifySearchRepair } from "../../../lib/cloudflare/e2e/search-verification";
import { e2eRows, hasE2ETable } from "../../../lib/cloudflare/e2e/generation-state";

export const E2E_SEARCH_REPAIR_QUEUE_NAME="worldcons-e2e-search-repair";
export interface E2ESearchConsumerEnvironment {
  E2E_PUBLIC_API?:{fetch(request:Request):Promise<Response>};
  WORLDCONS_INGEST_STAGE_ENVIRONMENT?:string;
  WORLDCONS_CORE:D1RuntimeDatabase; WORLDCONS_SEARCH:D1RuntimeDatabase;
  WORLDCONS_E2E_SEARCH_CONSUMER_ENABLED?:string;
  WORLDCONS_E2E_VERIFIER_ENABLED?:string;
  WORLDCONS_E2E_VERIFIER_API_BASE_URL?:string;
  WORLDCONS_E2E_DEPLOYMENT_REF?:string;
  WORLDCONS_E2E_STAGED_APPROVAL_ENABLED?:string;
  WORLDCONS_E2E_STAGED_SOURCES?:string;
}
interface QueueMessage { body:unknown; ack():void; retry(options?:{delaySeconds:number}):void }
export async function consumeE2ESearchRepairBatch(messages:readonly QueueMessage[],env:E2ESearchConsumerEnvironment) {
  if (env.WORLDCONS_E2E_SEARCH_CONSUMER_ENABLED!=="true") {
    for (const message of messages) message.retry({delaySeconds:300});
    return;
  }
  if (!await hasE2ETable(env.WORLDCONS_CORE,"e2e_search_apply_receipts_v1")
    || !await hasE2ETable(env.WORLDCONS_SEARCH,"e2e_search_generation_guards_v1")) throw new Error("e2e.consumer_schema_not_ready");
  const guards=await e2eRows(env.WORLDCONS_SEARCH,`SELECT name FROM sqlite_master WHERE type='trigger'
    AND name IN ('e2e_search_document_insert_guard','e2e_search_document_update_guard','e2e_search_document_delete_guard')`);
  if (guards.length!==3) throw new Error("e2e.consumer_guards_not_ready");
  if (env.WORLDCONS_E2E_VERIFIER_ENABLED==="true"
    && (!await hasE2ETable(env.WORLDCONS_CORE,"e2e_verification_jobs_v1")
      || !await hasE2ETable(env.WORLDCONS_CORE,"e2e_approval_evidence_v1")
      || !await hasE2ETable(env.WORLDCONS_CORE,"e2e_verification_evidence_v1"))) throw new Error("e2e.verifier_schema_not_ready");
  if(env.WORLDCONS_E2E_VERIFIER_ENABLED==="true"&&env.WORLDCONS_INGEST_STAGE_ENVIRONMENT==="production"&&!env.E2E_PUBLIC_API)throw new Error("e2e.public_api_binding_missing");
  const deferredVerification=async(body:unknown)=>{
    if(env.WORLDCONS_E2E_VERIFIER_ENABLED!=="true"||!isSearchRepairMessage(body))return false;const now=new Date().toISOString();
    return (await e2eRows(env.WORLDCONS_CORE,"SELECT j.generation_id FROM e2e_search_repair_outbox_v1 o JOIN e2e_verification_jobs_v1 j ON j.generation_id=o.generation_id WHERE o.outbox_id=? AND ((j.status IN ('pending','retry_wait') AND j.next_attempt_at>?) OR (j.status='leased' AND j.lease_expires_at>?))",body.outboxId,now,now)).length>0;
  };
  for (const message of messages) {
    try {
      const result=await consumeSearchRepair(env.WORLDCONS_CORE,env.WORLDCONS_SEARCH,message.body);
      if (result.status==="awaiting_verification"&&env.WORLDCONS_E2E_VERIFIER_ENABLED==="true") {
        const verified=await verifySearchRepair(env.WORLDCONS_CORE,env.WORLDCONS_SEARCH,message.body,{
          apiBaseUrl:env.WORLDCONS_E2E_VERIFIER_API_BASE_URL??"",deploymentRef:env.WORLDCONS_E2E_DEPLOYMENT_REF??"",
          ...(env.E2E_PUBLIC_API?{transport:"root-public-provider-service-binding" as const,fetch:((input,init)=>{const url=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);url.pathname=url.pathname.replace(/^\/api\/cclrag2(?=\/|$)/,"/api");return env.E2E_PUBLIC_API!.fetch(new Request(url,init));}) as typeof fetch}:{})});
        if (["retry","invalid","missing","awaiting_application"].includes(verified.status)) {if(await deferredVerification(message.body))message.ack();else message.retry({delaySeconds:60});}
        else message.ack();
        console[verified.status==="dead_letter"||verified.status==="blocked"?"error":"log"](JSON.stringify({event:"e2e_search_verification",status:verified.status,...("errorCode" in verified?{errorCode:verified.errorCode}:{})}));
        continue;
      }
      if (["retry","invalid","missing"].includes(result.status)) {if(await deferredVerification(message.body))message.ack();else message.retry({delaySeconds:60});}
      else message.ack(); // Durable apply receipt is not M4 completed_verified.
      console[result.status==="dead_letter"||result.status==="blocked"?"error":"log"](JSON.stringify({event:"e2e_search_repair_consumer",status:result.status}));
    } catch {
      message.retry({delaySeconds:60});
      console.error(JSON.stringify({event:"e2e_search_repair_consumer_unavailable"}));
    }
  }
}
