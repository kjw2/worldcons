import { canonicalJson } from "@/lib/backfill/canonical-json";

export const APPROVAL_HASH_SCHEMA = "worldcons.approval.v1";
export const GENERATION_HASH_SCHEMA = "worldcons.generation.v1";
export const PROJECTION_INPUT_SCHEMA = "worldcons.projection-input.v1";
// Bump when FTS encoding changes independently of search_documents.
export const FTS_INPUT_VERSION = 1;
export const STAGED_APPROVAL_POLICY = "worldcons.fr-es-staged-approval.v1";

/** Explicit opt-in. Evidence is supplied by the approval owner, not invented here. */
export interface E2EApprovalContext {
  policyVersion: string;
  mode: "human" | "automatic";
  evidenceRef: string;
  sourceEvidenceRef: string;
  pipelineRunId?: string | null;
  discoveryCandidateId?: string | null;
}

export interface E2EGenerationReceipt {
  generationId: string;
  generationSeq: number;
  approvalKey: string;
  approvalSnapshotHash: string;
  projectionInputHash: string;
  created: boolean;
  searchRepairOutboxId?: string;
}

export function validE2EApproval(value: unknown): value is E2EApprovalContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const bounded = (field: unknown, max: number) => typeof field === "string" && field.trim().length > 0 && field.length <= max;
  return bounded(input.policyVersion, 160)
    && (input.mode === "human" || input.mode === "automatic")
    && bounded(input.evidenceRef, 500) && bounded(input.sourceEvidenceRef, 500)
    && (input.pipelineRunId == null || bounded(input.pipelineRunId, 160))
    && (input.discoveryCandidateId == null || bounded(input.discoveryCandidateId, 160));
}

export async function sha256Canonical(value: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function json(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  return JSON.parse(value);
}

/**
 * Immutable P3/content fields only. Operational timestamps/storage locations,
 * retry/error metadata and actor/model accounting do not approve new content.
 * JSON key order is ignored; arrays, body whitespace and Unicode are preserved.
 * Missing optional role/anchor fields have the same explicit NULL as DB NULL.
 */
export async function approvalIdentity(articleId: string, snapshot: Record<string, unknown>, policyVersion: string) {
  const sourceContentHash = await sha256Canonical({ schema: "worldcons.source-text.v1", cleanedText: snapshot.cleaned_text ?? null });
  const fields = ["slug", "source_key", "jurisdiction", "institution_name", "content_type",
    "original_language", "original_title", "korean_title", "original_published_at",
    "original_url", "canonical_url", "cleaned_text", "case_key", "version_role",
    "source_anchor_version_id", "enrichment_source_content_hash", "source_content_hash",
    "authority_evidence_hash", "source_snapshot_hash", "case_metadata_snapshot", "case_identifiers_snapshot"];
  const body: Record<string, unknown> = { schema: APPROVAL_HASH_SCHEMA, articleId, sourceContentHash };
  for (const field of fields) body[field] = snapshot[field] ?? null;
  body.summary_json = json(snapshot.summary_json);
  body.source_metadata = json(snapshot.source_metadata);
  body.case_metadata_snapshot = json(snapshot.case_metadata_snapshot);
  body.case_identifiers_snapshot = json(snapshot.case_identifiers_snapshot);
  const approvalSnapshotHash = await sha256Canonical(body);
  const approvalKey = await sha256Canonical({ schema: APPROVAL_HASH_SCHEMA, articleId, sourceContentHash, approvalSnapshotHash, policyVersion });
  return { sourceContentHash, approvalSnapshotHash, approvalKey };
}

export function approvalContextDocument(input: E2EApprovalContext) {
  return { policyVersion: input.policyVersion, mode: input.mode, evidenceRef: input.evidenceRef,
    sourceEvidenceRef: input.sourceEvidenceRef, pipelineRunId: input.pipelineRunId ?? null,
    discoveryCandidateId: input.discoveryCandidateId ?? null };
}
