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
  inventoryMetadata: Record<string, unknown>;
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
  payloadSize?: number | null;
  replayability: "full_snapshot" | "bounded_evidence" | "non_replayable";
  immutableStorageRef: string | null;
  boundedReplayPayload: Record<string, unknown> | null;
  boundedReplayStorageRef?: string | null;
  externalizationContractVersion?: string | null;
  fetchContractVersion: string;
}

export interface CaseBackfillNormalizationArtifact {
  id: string;
  itemId: string;
  fetchArtifactId: string;
  parserVersion: string;
  normalizationContractVersion: string;
  normalizedOutput: import("@/lib/sources/types").NormalizedArticle | null;
  normalizedOutputHash: string;
  normalizedOutputStorageRef?: string | null;
  normalizedOutputSize?: number | null;
  externalizationContractVersion?: string | null;
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

export interface CaseBackfillEnumerationArtifact {
  providerKey: string;
  artifactKind: "page" | "boundary_probe" | "crosscheck";
  sequenceNumber: number;
  requestUrl: string;
  responseHash: string;
  recordManifestHash: string;
  recordCount: number;
  newestDecisionDate: string | null;
  oldestDecisionDate: string | null;
  observedLastPage: number | null;
  safeDetails: Record<string, unknown>;
}

export interface CaseBackfillPublicationResult {
  articleId: string;
  versionId: string;
  versionRevision: number;
  publicationRevision: number;
  articleSlug: string;
}

export type CaseBackfillArtifactExternalizationKind = "fetch" | "normalization";
export type CaseBackfillArtifactExternalizationTable =
  | "source_fetch_artifacts"
  | "source_normalization_artifacts";

export interface CaseBackfillExternalizationCandidate {
  artifactTable: CaseBackfillArtifactExternalizationTable;
  artifactId: string;
  itemId: string;
  sourceKey: string;
  kind: CaseBackfillArtifactExternalizationKind;
  inlinePayload: Record<string, unknown>;
  storedHash: string;
  storedSize: number | null;
}

export interface AttachArtifactExternalizationInput {
  artifactTable: CaseBackfillArtifactExternalizationTable;
  artifactId: string;
  storageRef: string;
  contentHash: string;
  contentSize: number;
  externalizationContractVersion: string;
  actorId: string | null;
}

export interface AttachArtifactExternalizationResult {
  artifactId: string;
  idempotent: boolean;
}

export interface CaseBackfillInlineClearCandidate {
  artifactTable: CaseBackfillArtifactExternalizationTable;
  artifactId: string;
  itemId: string;
  sourceKey: string;
  kind: CaseBackfillArtifactExternalizationKind;
  storageRef: string;
  storedHash: string;
  storedSize: number;
  externalizationContractVersion: string;
}

export interface ClearArtifactInlineInput {
  artifactTable: CaseBackfillArtifactExternalizationTable;
  artifactId: string;
  expectedStorageRef: string;
  expectedContentHash: string;
  expectedContentSize: number;
  externalizationContractVersion: string;
  actorId: string | null;
}

export interface ClearArtifactInlineResult {
  artifactId: string;
  idempotent: boolean;
}

/**
 * Blob-only restore candidate: an artifact whose inline payload is absent. Every
 * externalization metadata field is nullable so an incomplete or contradictory row
 * is visible to the service and classified (conflict/not_ready) before any Blob
 * read, rather than being silently dropped from the listing.
 */
export interface CaseBackfillInlineRestoreCandidate {
  artifactTable: CaseBackfillArtifactExternalizationTable;
  artifactId: string;
  itemId: string;
  sourceKey: string;
  kind: CaseBackfillArtifactExternalizationKind;
  storageRef: string | null;
  storedHash: string | null;
  storedSize: number | null;
  externalizedAt: string | null;
  externalizationContractVersion: string | null;
}

export interface RestoreArtifactInlineInput {
  artifactTable: CaseBackfillArtifactExternalizationTable;
  artifactId: string;
  inlinePayload: Record<string, unknown>;
  document: string;
  storageRef: string;
  contentHash: string;
  contentSize: number;
  externalizationContractVersion: string;
  actorId: string | null;
}

export interface RestoreArtifactInlineResult {
  artifactId: string;
  idempotent: boolean;
}

/**
 * M5 read-only readiness row: one fetch/normalization artifact reduced to
 * presence and externalization/ledger metadata only. It never carries payload
 * content, and the storage ref/hash/size it exposes is consumed in-memory by the
 * readiness module for optional bounded Blob verification; it is never reported.
 */
export interface CaseBackfillArtifactReadinessRow {
  artifactTable: CaseBackfillArtifactExternalizationTable;
  artifactId: string;
  itemId: string;
  sourceKey: string;
  kind: CaseBackfillArtifactExternalizationKind;
  replayability: string | null;
  inlinePresent: boolean;
  storageRef: string | null;
  storedHash: string;
  storedSize: number | null;
  externalizationContractVersion: string | null;
  externalizedAtPresent: boolean;
  ledgerCovered: boolean;
}
