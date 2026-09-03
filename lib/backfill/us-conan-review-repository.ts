import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import type { ConstitutionalRelevanceStatus, UsCourtClassification } from "@/lib/backfill/us-constitution-annotated";

export interface StoredUsConanEssayEvidence {
  id: string;
  essayId: string;
  title: string;
  url: string;
}

export interface StoredUsConanAuthorityEvidence {
  id: string;
  status: string;
  detailsUrl: string;
  pdfUrl: string | null;
  observedAt: string;
}

export interface StoredUsConanReviewContext {
  id: string;
  stableCandidateKey: string;
  caseName: string;
  citation: string;
  normalizedCitation: string;
  courtClassification: UsCourtClassification;
  reviewRevision: number;
  currentStatus: ConstitutionalRelevanceStatus;
  essays: StoredUsConanEssayEvidence[];
  currentAuthority: StoredUsConanAuthorityEvidence | null;
}

export interface AppendUsConanReviewInput {
  candidateId: string;
  expectedRevision: number;
  status: Exclude<ConstitutionalRelevanceStatus, "candidate">;
  officialScotusIdentityVerified: boolean;
  constitutionalEssayContextVerified: boolean;
  officialAuthorityVerified: boolean;
  constitutionalHoldingVerified: boolean;
  authorityArtifactId: string | null;
  officialAuthorityUrl: string | null;
  essayEvidenceIds: string[];
  holdingEvidence: Array<{
    sourceUrl: string;
    locator: string;
    constitutionalQuestion: string;
  }>;
  safeEvidence: Record<string, unknown>;
  reviewedBy: string;
  reviewReason: string;
}

export interface AppendedUsConanReview {
  reviewId: string;
  revision: number;
  status: Exclude<ConstitutionalRelevanceStatus, "candidate">;
}

export interface UsConanReviewRepository {
  getReviewContext(candidateId: string): Promise<StoredUsConanReviewContext>;
  appendReview(input: AppendUsConanReviewInput): Promise<AppendedUsConanReview>;
}

function requiredClient() {
  const client = getSupabaseServiceRoleAdmin();
  if (!client) throw new Error("us_review.database_unavailable");
  return client;
}

function databaseError(error: { message?: string } | null) {
  if (error) throw new Error(error.message || "us_review.database_error");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstRow(value: unknown) {
  if (Array.isArray(value)) return record(value[0]);
  return record(value);
}

function requiredString(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== "string" || !value) throw new Error("us_review.context_invalid");
  return value;
}

function courtClassification(value: unknown): UsCourtClassification {
  if (["scotus_candidate", "lower_federal", "state_or_other", "unknown"].includes(String(value))) {
    return value as UsCourtClassification;
  }
  throw new Error("us_review.context_invalid");
}

function relevanceStatus(value: unknown): ConstitutionalRelevanceStatus {
  if (["candidate", "verified", "uncertain", "rejected"].includes(String(value))) {
    return value as ConstitutionalRelevanceStatus;
  }
  throw new Error("us_review.context_invalid");
}

export const postgresUsConanReviewRepository: UsConanReviewRepository = {
  async getReviewContext(candidateId) {
    const client = requiredClient();
    const candidateResult = await client
      .from("us_conan_candidate_current_v1")
      .select("id,snapshot_id,stable_candidate_key,case_name,citation,normalized_citation,court_classification,review_revision,constitutional_relevance_status")
      .eq("id", candidateId)
      .single();
    databaseError(candidateResult.error);
    const candidate = record(candidateResult.data);
    if (!candidate) throw new Error("us_review.candidate_not_found");

    const snapshotResult = await client
      .from("us_conan_candidate_snapshots_v1")
      .select("status")
      .eq("id", requiredString(candidate, "snapshot_id"))
      .single();
    databaseError(snapshotResult.error);
    if (record(snapshotResult.data)?.status !== "closed") throw new Error("us_review.closed_candidate_required");

    const essayResult = await client
      .from("us_conan_candidate_essay_evidence_v1")
      .select("id,essay_id,essay_title,essay_url")
      .eq("candidate_id", candidateId)
      .order("essay_id", { ascending: true });
    databaseError(essayResult.error);
    if (!Array.isArray(essayResult.data) || essayResult.data.length === 0) {
      throw new Error("us_review.essay_evidence_missing");
    }
    const essays = essayResult.data.map((value) => {
      const row = record(value);
      if (!row) throw new Error("us_review.context_invalid");
      return {
        id: requiredString(row, "id"),
        essayId: requiredString(row, "essay_id"),
        title: requiredString(row, "essay_title"),
        url: requiredString(row, "essay_url"),
      };
    });

    const authorityResult = await client
      .from("us_conan_candidate_authority_current_v1")
      .select("id,status,details_url,pdf_url,observed_at")
      .eq("candidate_id", candidateId)
      .maybeSingle();
    databaseError(authorityResult.error);
    const authority = record(authorityResult.data);
    const reviewRevision = Number(candidate.review_revision);
    if (!Number.isInteger(reviewRevision) || reviewRevision < 0) throw new Error("us_review.context_invalid");

    return {
      id: requiredString(candidate, "id"),
      stableCandidateKey: requiredString(candidate, "stable_candidate_key"),
      caseName: requiredString(candidate, "case_name"),
      citation: requiredString(candidate, "citation"),
      normalizedCitation: requiredString(candidate, "normalized_citation"),
      courtClassification: courtClassification(candidate.court_classification),
      reviewRevision,
      currentStatus: relevanceStatus(candidate.constitutional_relevance_status),
      essays,
      currentAuthority: authority ? {
        id: requiredString(authority, "id"),
        status: requiredString(authority, "status"),
        detailsUrl: requiredString(authority, "details_url"),
        pdfUrl: typeof authority.pdf_url === "string" ? authority.pdf_url : null,
        observedAt: requiredString(authority, "observed_at"),
      } : null,
    };
  },

  async appendReview(input) {
    const { data, error } = await requiredClient().rpc("us_conan_candidate_review_v2", {
      p_candidate_id: input.candidateId,
      p_expected_revision: input.expectedRevision,
      p_status: input.status,
      p_official_scotus_identity_verified: input.officialScotusIdentityVerified,
      p_constitutional_essay_context_verified: input.constitutionalEssayContextVerified,
      p_official_authority_verified: input.officialAuthorityVerified,
      p_constitutional_holding_verified: input.constitutionalHoldingVerified,
      p_authority_artifact_id: input.authorityArtifactId,
      p_official_authority_url: input.officialAuthorityUrl,
      p_essay_evidence_ids: input.essayEvidenceIds,
      p_holding_evidence: input.holdingEvidence,
      p_safe_evidence: input.safeEvidence,
      p_reviewed_by: input.reviewedBy,
      p_review_reason: input.reviewReason,
    });
    databaseError(error);
    const row = firstRow(data);
    const revision = Number(row?.review_revision);
    if (!row || typeof row.review_id !== "string" || !Number.isInteger(revision) || revision < 1) {
      throw new Error("us_review.write_failed");
    }
    return {
      reviewId: row.review_id,
      revision,
      status: relevanceStatus(row.review_status) as AppendedUsConanReview["status"],
    };
  },
};
