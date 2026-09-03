import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import type { UsCourtClassification } from "@/lib/backfill/us-constitution-annotated";
import type { GovInfoAuthorityResolution } from "@/lib/crawlee/us-govinfo-reports-resolver";

export interface StoredUsConanCandidate {
  id: string;
  caseName: string;
  citation: string;
  courtClassification: UsCourtClassification;
}

export interface UsConanAuthorityRepository {
  getCandidate(candidateId: string): Promise<StoredUsConanCandidate>;
  recordAuthority(
    candidateId: string,
    resolverVersion: string,
    resolution: GovInfoAuthorityResolution,
  ): Promise<string>;
}

function requiredClient() {
  const client = getSupabaseServiceRoleAdmin();
  if (!client) throw new Error("us_authority.database_unavailable");
  return client;
}

function databaseError(error: { message?: string } | null) {
  if (error) throw new Error(error.message || "us_authority.database_error");
}

function courtClassification(value: unknown): UsCourtClassification {
  if (["scotus_candidate", "lower_federal", "state_or_other", "unknown"].includes(String(value))) {
    return value as UsCourtClassification;
  }
  throw new Error("us_authority.candidate_invalid");
}

export const postgresUsConanAuthorityRepository: UsConanAuthorityRepository = {
  async getCandidate(candidateId) {
    const { data, error } = await requiredClient()
      .from("us_conan_case_candidates_v1")
      .select("id,case_name,citation,court_classification,us_conan_candidate_snapshots_v1!inner(status)")
      .eq("id", candidateId)
      .eq("us_conan_candidate_snapshots_v1.status", "closed")
      .single();
    databaseError(error);
    if (!data || typeof data.id !== "string" || typeof data.case_name !== "string" || typeof data.citation !== "string") {
      throw new Error("us_authority.candidate_not_found");
    }
    return {
      id: data.id,
      caseName: data.case_name,
      citation: data.citation,
      courtClassification: courtClassification(data.court_classification),
    };
  },

  async recordAuthority(candidateId, resolverVersion, resolution) {
    const { data, error } = await requiredClient().rpc("us_conan_candidate_authority_record_v1", {
      p_candidate_id: candidateId,
      p_resolver_version: resolverVersion,
      p_status: resolution.status,
      p_citation: resolution.citation,
      p_official_case_name: resolution.officialCaseName,
      p_details_url: resolution.detailsUrl,
      p_pdf_url: resolution.pdfUrl,
      p_payload_hash: resolution.payloadHash,
      p_blocking: resolution.blocking,
      p_observed_at: resolution.observedAt,
    });
    databaseError(error);
    if (typeof data !== "string") throw new Error("us_authority.artifact_write_failed");
    return data;
  },
};
