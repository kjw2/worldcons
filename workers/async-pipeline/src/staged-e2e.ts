import type { D1RuntimeDatabase } from "../../../lib/cloudflare/d1/runtime-binding";
import { readArticlePublicationSnapshotFromD1, transitionArticlePublicationInD1 } from "../../../lib/cloudflare/core-write/authority";
import { consumeSearchRepair } from "../../../lib/cloudflare/e2e/search-repair-consumer";
import { verifySearchRepair, verificationApiBase, type SearchVerificationOptions } from "../../../lib/cloudflare/e2e/search-verification";
import { currentGenerations } from "../../../lib/cloudflare/e2e/generation-state";
import { STAGED_APPROVAL_POLICY, validE2EApproval, type E2EApprovalContext, type E2EGenerationReceipt } from "../../../lib/cloudflare/e2e/contracts";

export interface StagedE2EOptions {
  sources:readonly string[];
  search:D1RuntimeDatabase;
  verification:SearchVerificationOptions;
}
export async function publishStagedApproved(core:D1RuntimeDatabase,articleId:string,approval:E2EApprovalContext) {
  if (!validE2EApproval(approval)||approval.mode!=="automatic"||approval.policyVersion!==STAGED_APPROVAL_POLICY)
    throw new Error("e2e.staged_approval_missing");
  const snapshot=await readArticlePublicationSnapshotFromD1(core,articleId);
  if (!snapshot.ok) throw new Error("e2e.staged_snapshot_unavailable");
  const result=await transitionArticlePublicationInD1(core,{articleId,expectedVersionRevision:snapshot.data.versionRevision,
    expectedPublicationRevision:snapshot.data.publicationRevision,expectedLegacyUpdatedAt:snapshot.data.legacyUpdatedAt,
    idempotencyKey:`e2e-staged:${approval.evidenceRef}`,targetState:"published",captureLegacy:true,actorType:"compatibility",
    actorId:"ingest-stage-e2e",reason:"Recorded official-source and summary policy approval",e2eApproval:approval});
  if (!result.ok) throw new Error(`e2e.staged_publication_failed:${result.error.code}`);
  if (!result.data.generation) throw new Error("e2e.staged_generation_missing");
  const g=(await currentGenerations(core,[articleId])).get(articleId);
  if (!g?.input_current||g.generation_id!==result.data.generation.generationId) throw new Error("e2e.staged_publication_superseded");
  return result.data;
}
export async function finishStagedSearch(core:D1RuntimeDatabase,options:StagedE2EOptions,generation:E2EGenerationReceipt) {
  const message={schemaVersion:1,type:"e2e-search-repair",outboxId:generation.searchRepairOutboxId};
  const applied=await consumeSearchRepair(core,options.search,message);
  if (!["awaiting_verification","terminal"].includes(applied.status)) return {status:"retry"} as const;
  return verifySearchRepair(core,options.search,message,options.verification);
}

/** Default off; a malformed protected cohort must never fall through to legacy writers. */
export function stagedE2EOptionsFromEnvironment(env:{
  WORLDCONS_SEARCH:D1RuntimeDatabase; WORLDCONS_E2E_STAGED_APPROVAL_ENABLED?:string; WORLDCONS_E2E_STAGED_SOURCES?:string;
  WORLDCONS_E2E_VERIFIER_ENABLED?:string; WORLDCONS_E2E_VERIFIER_API_BASE_URL?:string; WORLDCONS_E2E_DEPLOYMENT_REF?:string;
}):StagedE2EOptions|undefined {
  if (env.WORLDCONS_E2E_STAGED_APPROVAL_ENABLED!=="true") return undefined;
  const sources=[...new Set((env.WORLDCONS_E2E_STAGED_SOURCES??"").split(",").map(s=>s.trim()))];
  if (env.WORLDCONS_E2E_VERIFIER_ENABLED!=="true"||!sources.length
    || sources.some(s=>!["fr-conseil-constitutionnel","es-tribunal-constitucional"].includes(s))
    || !env.WORLDCONS_E2E_DEPLOYMENT_REF?.trim()||env.WORLDCONS_E2E_DEPLOYMENT_REF.length>500)
    throw new Error("e2e.staged_configuration_incomplete");
  const apiBaseUrl=verificationApiBase(env.WORLDCONS_E2E_VERIFIER_API_BASE_URL??"");
  return {sources,search:env.WORLDCONS_SEARCH,verification:{apiBaseUrl,deploymentRef:env.WORLDCONS_E2E_DEPLOYMENT_REF}};
}
