export const CASE_BACKFILL_PHASES = ["discover", "fetch", "normalize", "verify", "publish", "reconcile"] as const;
export const CASE_BACKFILL_ITEM_PHASES = ["fetch", "normalize", "verify", "publish"] as const;
export const CASE_BACKFILL_COVERAGE_ASSURANCE = [
  "authoritative_enumerated",
  "authoritative_counted",
  "authoritative_crosschecked",
  "external_index_assisted",
  "best_effort",
] as const;

export type CaseBackfillPhase = (typeof CASE_BACKFILL_PHASES)[number];
export type CaseBackfillItemPhase = (typeof CASE_BACKFILL_ITEM_PHASES)[number];
export type CaseBackfillCoverageAssurance = (typeof CASE_BACKFILL_COVERAGE_ASSURANCE)[number];

export interface CaseBackfillAttemptAuthority {
  attemptId: string;
  runId: string;
  fencingToken: string;
  leaseExpiresAt: string;
}

export interface CaseBackfillPassInput {
  cohort: "catalog-backfill";
  snapshotId: string;
  phase: CaseBackfillPhase;
  passNumber: number;
  batchLimit: number;
  parserVersion?: string;
  normalizationContractVersion?: string;
  fetchContractVersion?: string;
}

export interface CaseBackfillClaimedItem {
  itemId: string;
  stableItemKey: string;
  sourceRecordId: string | null;
  discoveredUrl: string;
  authorityUrl: string | null;
  documentType: string | null;
  decisionDateHint: string | null;
  resolutionStatus: string;
  currentFetchArtifactId: string | null;
  currentNormalizationArtifactId: string | null;
  verifiedNormalizationArtifactId: string | null;
  publishedNormalizationArtifactId: string | null;
  itemLeaseExpiresAt: string;
}

export interface CaseBackfillSnapshot {
  id: string;
  sourceKey: string;
  scopeFrom: string | null;
  scopeTo: string | null;
  documentType: string;
  parserVersion: string;
  sourcePolicyVersion: string;
  status: string;
}

export interface CaseBackfillSourcePolicy {
  sourceKey: string;
  policyVersion: string;
  normalizeReplayPolicy: "full_snapshot" | "bounded_evidence" | "non_replayable";
  boundedReplayFields: string[];
  minRequestDelayMs: number;
  maxConcurrency: number;
  reviewDueAt: string;
}

export interface CaseBackfillFetchArtifact {
  id: string;
  itemId: string;
  sourcePolicyVersion: string;
  authorityUrl: string;
  payloadHash: string;
  replayability: "full_snapshot" | "bounded_evidence" | "non_replayable";
  immutableStorageRef: string | null;
  boundedReplayPayload: Record<string, unknown> | null;
  fetchContractVersion: string;
}

export interface CaseBackfillNormalizationArtifact {
  id: string;
  itemId: string;
  fetchArtifactId: string;
  parserVersion: string;
  normalizationContractVersion: string;
  normalizedOutput: import("@/lib/sources/types").NormalizedArticle;
  normalizedOutputHash: string;
  validationStatus: "valid" | "invalid";
}

export interface CaseBackfillSnapshotStatus {
  snapshotId: string;
  sourceKey: string;
  snapshotStatus: string;
  discoveredTotal: number;
  terminalTotal: number;
  processingCompletion: number;
  expectedCount: number | null;
  coverageAssurance: CaseBackfillCoverageAssurance;
  corpusCoverage: number | null;
  claimed: number;
  retryWait: number;
  needsNormalize: number;
  needsReverify: number;
  needsRepublish: number;
  failed: number;
  currentConformant: number;
  currentConformance: number;
  manifestHash: string | null;
}

export interface CaseBackfillPassResult {
  phase: CaseBackfillPhase;
  snapshotId: string;
  passNumber: number;
  claimed: number;
  succeeded: number;
  retryableFailed: number;
  terminalFailed: number;
  backlogRemaining: boolean;
}

export interface CaseBackfillPublicationResult {
  articleId: string;
  versionId: string;
  versionRevision: number;
  publicationRevision: number;
  articleSlug: string;
}
