import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import type { ConstitutionAnnotatedCandidate } from "@/lib/backfill/us-constitution-annotated";

interface OpenUsConanSnapshotInput {
  sourcePolicyVersion: string;
  payloadHash: string;
  parserVersion: string;
  captureMode: "reviewed_fixture";
  citationCoverageAssurance: "best_effort";
  observedAt: string;
  createdBy: string;
}

export interface ClosedUsConanSnapshot {
  snapshotId: string;
  candidateCount: number;
  manifestHash: string;
}

export interface OpenedUsConanSnapshot {
  snapshotId: string;
  status: "open" | "closed";
  candidateCount: number;
  manifestHash: string | null;
}

export interface UsConanCandidateRepository {
  openSnapshot(input: OpenUsConanSnapshotInput): Promise<OpenedUsConanSnapshot>;
  upsertCandidate(snapshotId: string, candidate: ConstitutionAnnotatedCandidate): Promise<string>;
  closeSnapshot(snapshotId: string): Promise<ClosedUsConanSnapshot>;
}

function requiredClient() {
  const client = getSupabaseServiceRoleAdmin();
  if (!client) throw new Error("us_conan.database_unavailable");
  return client;
}

function databaseError(error: { message?: string } | null) {
  if (error) throw new Error(error.message || "us_conan.database_error");
}

function firstRow(value: unknown) {
  return Array.isArray(value) && typeof value[0] === "object" && value[0] !== null
    ? value[0] as Record<string, unknown>
    : null;
}

export const postgresUsConanCandidateRepository: UsConanCandidateRepository = {
  async openSnapshot(input) {
    const { data, error } = await requiredClient().rpc("us_conan_candidate_snapshot_open_v1", {
      p_source_policy_version: input.sourcePolicyVersion,
      p_payload_hash: input.payloadHash,
      p_parser_version: input.parserVersion,
      p_capture_mode: input.captureMode,
      p_citation_coverage_assurance: input.citationCoverageAssurance,
      p_observed_at: input.observedAt,
      p_created_by: input.createdBy,
    });
    databaseError(error);
    if (typeof data !== "string") throw new Error("us_conan.snapshot_open_failed");
    const snapshot = await requiredClient()
      .from("us_conan_candidate_snapshots_v1")
      .select("id,status,candidate_count,manifest_hash")
      .eq("id", data)
      .single();
    databaseError(snapshot.error);
    if (!snapshot.data || (snapshot.data.status !== "open" && snapshot.data.status !== "closed")) {
      throw new Error("us_conan.snapshot_open_failed");
    }
    return {
      snapshotId: snapshot.data.id,
      status: snapshot.data.status,
      candidateCount: Number(snapshot.data.candidate_count),
      manifestHash: snapshot.data.manifest_hash,
    };
  },

  async upsertCandidate(snapshotId, candidate) {
    const { data, error } = await requiredClient().rpc("us_conan_candidate_upsert_v1", {
      p_snapshot_id: snapshotId,
      p_stable_candidate_key: candidate.stableCandidateKey,
      p_case_name: candidate.caseName,
      p_citation: candidate.citation,
      p_normalized_citation: candidate.normalizedCitation,
      p_court_classification: candidate.courtClassification,
      p_priority: candidate.priority,
      p_priority_reasons: candidate.priorityReasons,
      p_essay_references: candidate.essayReferences.map((reference) => ({
        essayId: reference.essayId,
        title: reference.title,
        url: reference.url,
      })),
    });
    databaseError(error);
    if (typeof data !== "string") throw new Error("us_conan.candidate_upsert_failed");
    return data;
  },

  async closeSnapshot(snapshotId) {
    const { data, error } = await requiredClient().rpc("us_conan_candidate_snapshot_close_v1", {
      p_snapshot_id: snapshotId,
    });
    databaseError(error);
    const row = firstRow(data);
    const candidateCount = typeof row?.candidate_count === "number"
      ? row.candidate_count
      : Number(row?.candidate_count);
    if (
      !row
      || typeof row.snapshot_id !== "string"
      || !Number.isInteger(candidateCount)
      || candidateCount < 1
      || typeof row.manifest_hash !== "string"
      || !/^[0-9a-f]{64}$/.test(row.manifest_hash)
    ) throw new Error("us_conan.snapshot_close_failed");
    return {
      snapshotId: row.snapshot_id,
      candidateCount,
      manifestHash: row.manifest_hash,
    };
  },
};
