import {
  applyConstitutionAnnotatedPriority,
  assertConstitutionAnnotatedDiscoveryEnabled,
  parseConstitutionAnnotatedCasesHtml,
  type ConstitutionAnnotatedCandidate,
} from "@/lib/backfill/us-constitution-annotated";
import {
  postgresUsConanCandidateRepository,
  type ClosedUsConanSnapshot,
  type UsConanCandidateRepository,
} from "@/lib/backfill/us-conan-repository";

export interface UsConanCandidateImportInput {
  html: string;
  payloadHash: string;
  parserVersion: string;
  observedAt: string;
  sourcePolicyVersion: string | null;
  createdBy: string;
  execute: boolean;
  priorityCitations?: ReadonlySet<string>;
}

export interface UsConanCandidateImportResult {
  mode: "plan" | "imported";
  candidateCount: number;
  classifications: Record<ConstitutionAnnotatedCandidate["courtClassification"], number>;
  prioritizedCount: number;
  snapshot: ClosedUsConanSnapshot | null;
  candidates: ConstitutionAnnotatedCandidate[];
}

export interface UsConanCandidateImportDependencies {
  repository?: UsConanCandidateRepository;
  environment?: Record<string, string | undefined>;
}

function assertHash(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("us_conan.invalid_payload_hash");
}

function assertObservedAt(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > Date.now() + 300_000) {
    throw new Error("us_conan.invalid_observed_at");
  }
}

export async function importUsConanCandidateGraph(
  input: UsConanCandidateImportInput,
  dependencies: UsConanCandidateImportDependencies = {},
): Promise<UsConanCandidateImportResult> {
  assertHash(input.payloadHash);
  assertObservedAt(input.observedAt);
  if (!input.parserVersion.trim() || input.parserVersion.length > 120) throw new Error("us_conan.invalid_parser_version");
  const priorityCitations = input.priorityCitations ?? new Set<string>();
  const candidates = parseConstitutionAnnotatedCasesHtml(input.html)
    .map((candidate) => applyConstitutionAnnotatedPriority(candidate, priorityCitations));
  const classifications: UsConanCandidateImportResult["classifications"] = {
    scotus_candidate: 0,
    lower_federal: 0,
    state_or_other: 0,
    unknown: 0,
  };
  for (const candidate of candidates) classifications[candidate.courtClassification] += 1;
  const base = {
    candidateCount: candidates.length,
    classifications,
    prioritizedCount: candidates.filter((candidate) => candidate.priority > 0).length,
    candidates,
  };
  if (!input.execute) return { mode: "plan", snapshot: null, ...base };

  assertConstitutionAnnotatedDiscoveryEnabled(dependencies.environment ?? process.env);
  if (!input.sourcePolicyVersion?.trim()) throw new Error("us_conan.source_policy_required");
  const repository = dependencies.repository ?? postgresUsConanCandidateRepository;
  const opened = await repository.openSnapshot({
    sourcePolicyVersion: input.sourcePolicyVersion.trim(),
    payloadHash: input.payloadHash,
    parserVersion: input.parserVersion.trim(),
    captureMode: "reviewed_fixture",
    citationCoverageAssurance: "best_effort",
    observedAt: input.observedAt,
    createdBy: input.createdBy,
  });
  if (opened.status === "closed") {
    if (
      opened.candidateCount !== candidates.length
      || !opened.manifestHash
      || !/^[0-9a-f]{64}$/.test(opened.manifestHash)
    ) throw new Error("us_conan.closed_snapshot_mismatch");
    return {
      mode: "imported",
      snapshot: {
        snapshotId: opened.snapshotId,
        candidateCount: opened.candidateCount,
        manifestHash: opened.manifestHash,
      },
      ...base,
    };
  }
  for (const candidate of candidates) await repository.upsertCandidate(opened.snapshotId, candidate);
  const snapshot = await repository.closeSnapshot(opened.snapshotId);
  if (snapshot.candidateCount !== candidates.length) throw new Error("us_conan.snapshot_count_mismatch");
  return { mode: "imported", snapshot, ...base };
}
