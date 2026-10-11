import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { sha256Canonical } from "./contracts";

export interface SearchRepairIdentity {
  articleId: string;
  generationId: string;
  generationSeq: number;
  versionId: string;
  versionRevision: number;
  publicationId: string;
  publicationRevision: number;
  publicationState: string;
  policyVersion: string;
  projectionInputHash: string;
  evidenceRef: string;
}

export async function searchRepairReservation(binding: D1RuntimeDatabase, identity: SearchRepairIdentity, now: string) {
  const operation = identity.publicationState === "published" ? "project" : "remove";
  const outboxId = await sha256Canonical({ schema: "worldcons.search-repair.v1", articleId: identity.articleId,
    generationId: identity.generationId, operation });
  // Replays (including adoption of an M1 generation) reuse the durable row;
  // they never reset attempts, completed evidence, or an active lease.
  const insert = binding.prepare(`INSERT INTO e2e_search_repair_outbox_v1
    (outbox_id,article_id,generation_id,generation_seq,operation,expected_version_id,
     expected_version_revision,expected_publication_id,expected_publication_revision,
     expected_publication_state,policy_version,projection_input_hash,payload_evidence_ref,
     next_attempt_at,next_dispatch_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(article_id,generation_id,operation) DO NOTHING`).bind(
    outboxId,identity.articleId,identity.generationId,identity.generationSeq,operation,identity.versionId,
    identity.versionRevision,identity.publicationId,identity.publicationRevision,identity.publicationState,
    identity.policyVersion,identity.projectionInputHash,identity.evidenceRef,now,now,now,now);
  return { outboxId, operation, insert };
}
