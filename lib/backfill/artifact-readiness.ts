import {
  caseBackfillArtifactBlobFlagErrors,
  caseBackfillArtifactBlobReadEnabled,
  caseBackfillArtifactBlobReadReady,
  caseBackfillArtifactBlobWriteEnabled,
  caseBackfillArtifactBlobWriteReady,
} from "@/lib/backfill/flags";
import type { CaseBackfillRepository } from "@/lib/backfill/repository";
import type {
  CaseBackfillArtifactExternalizationKind,
  CaseBackfillArtifactReadinessRow,
} from "@/lib/backfill/types";
import {
  ARTIFACT_BLOB_CONTRACT_VERSION,
  sha256Hex,
  type ArtifactBlobStore,
} from "@/lib/storage/blob";

/**
 * M5 operational readiness/observability for the private Blob artifact migration.
 *
 * This module is read-only and aggregate-only: it pages through fetch and
 * normalization artifacts with a bounded keyset cursor, classifies each row into
 * presence/externalization/ledger states, and returns counts and rollout gates.
 * It never emits storage refs, payload content, hashes, tokens, or signed URLs,
 * and it performs no mutation. Blob verification is optional and off by default;
 * when enabled it head/get verifies a bounded sample and reports only aggregate
 * { sampled, read_errors, size_mismatches, hash_mismatches, invalid_documents }.
 *
 * Both Blob feature flags default to OFF. `NEW_WRITE_READY` and
 * `INLINE_CLEAR_READY` are purely derived decision gates; this module never
 * flips a flag and never clears inline content. This module is read-only and
 * never restores either. A real inline clear can be rolled back only through the
 * dedicated forward-only restore path (`pnpm restore:inline-artifacts`), which is
 * a separate operation reported here as `dedicated_restore_available`.
 *
 * Verification samples are counted per artifact kind, and `INLINE_CLEAR_READY`
 * additionally requires every selected kind with `clearableRows > 0` to have at
 * least one attempted sample. If `verificationSampleSize` is too small to cover
 * all such kinds, the gate stays not-ready with an explicit blocking reason
 * rather than passing on a partial, order-dependent sample.
 */

export const ARTIFACT_READINESS_KINDS: readonly CaseBackfillArtifactExternalizationKind[] = [
  "fetch",
  "normalization",
];
export const ARTIFACT_READINESS_MAX_BATCH_SIZE = 100;
export const ARTIFACT_READINESS_MAX_BATCHES = 1000;
export const ARTIFACT_READINESS_MAX_VERIFICATION_SAMPLE = 100;
export const ARTIFACT_READINESS_INLINE_RESTORE = "dedicated_restore_available";

export interface CaseBackfillArtifactReadinessDependencies {
  repository: Pick<CaseBackfillRepository, "listArtifactReadinessRows">;
  store?: ArtifactBlobStore | null;
  environment?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface CaseBackfillArtifactReadinessInput {
  kinds?: readonly CaseBackfillArtifactExternalizationKind[];
  sourceKey?: string | null;
  batchSize: number;
  maxBatches: number;
  verificationSampleSize?: number;
  afterArtifactId?: string | null;
}

export interface ArtifactReadinessTotals {
  totalRows: number;
  inlinePresentRows: number;
  externalizedRows: number;
  dualCopyRows: number;
  blobOnlyRows: number;
  inlineOnlyRows: number;
  metadataInconsistentRows: number;
  contractMismatchRows: number;
  ledgerCoveredRows: number;
  clearableRows: number;
  clearableLedgerCoveredRows: number;
  inlineBytesEstimated: number;
  inlineSizeUnavailableRows: number;
  batches: number;
  truncated: boolean;
}

export interface ArtifactReadinessVerification {
  requested: boolean;
  sampleSize: number;
  candidatesConsidered: number;
  sampled: number;
  verifiedOk: number;
  readErrors: number;
  sizeMismatches: number;
  hashMismatches: number;
  invalidDocuments: number;
  sampledByKind: Record<CaseBackfillArtifactExternalizationKind, number>;
}

export interface ArtifactReadinessGates {
  readEnabled: boolean;
  writeEnabled: boolean;
  writeWithoutRead: boolean;
  readFlagReady: boolean;
  writeFlagReady: boolean;
  flagErrors: string[];
  scanComplete: boolean;
  metadataCritical: boolean;
  verificationRequested: boolean;
  verificationReady: boolean;
  verificationKindCoverageReady: boolean;
  ledgerCoverageReady: boolean;
  newWriteReady: boolean;
  inlineClearReady: boolean;
  critical: boolean;
  blocking: string[];
}

export interface ArtifactReadinessReport {
  event: "artifact_blob_readiness";
  readOnly: true;
  machineReadable: true;
  observedAt: string;
  sourceKey: string | null;
  kinds: CaseBackfillArtifactExternalizationKind[];
  contractVersion: string;
  writeFlagsDefaultOff: boolean;
  inlineRestore: typeof ARTIFACT_READINESS_INLINE_RESTORE;
  fetch: ArtifactReadinessTotals;
  normalization: ArtifactReadinessTotals;
  combined: ArtifactReadinessTotals;
  verification: ArtifactReadinessVerification;
  gates: ArtifactReadinessGates;
  decisions: {
    newWriteReady: boolean;
    inlineClearReady: boolean;
  };
  blobObjectsDeleted: 0;
  publicCatalogWrites: 0;
  geminiCalls: 0;
  storageRefsEmitted: 0;
  perRowPayloadsEmitted: 0;
}

export interface ArtifactReadinessClassification {
  inlinePresent: boolean;
  externalized: boolean;
  dualCopy: boolean;
  blobOnly: boolean;
  inlineOnly: boolean;
  clearable: boolean;
  metadataInconsistent: boolean;
  contractMismatch: boolean;
  ledgerCovered: boolean;
  recordedSize: number | null;
}

interface ArtifactVerificationCandidate {
  kind: CaseBackfillArtifactExternalizationKind;
  storageRef: string;
  expectedHash: string;
  expectedSize: number | null;
}

function nonEmptyText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function boundedInteger(value: number, name: string, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`artifact_readiness.invalid_${name}`);
  return value;
}

function normalizeKinds(kinds?: readonly CaseBackfillArtifactExternalizationKind[]) {
  if (!kinds || kinds.length === 0) return [...ARTIFACT_READINESS_KINDS];
  const seen = new Set<CaseBackfillArtifactExternalizationKind>();
  for (const kind of kinds) {
    if (!ARTIFACT_READINESS_KINDS.includes(kind)) throw new Error("artifact_readiness.invalid_kind");
    seen.add(kind);
  }
  return ARTIFACT_READINESS_KINDS.filter((kind) => seen.has(kind));
}

export function emptyArtifactReadinessTotals(): ArtifactReadinessTotals {
  return {
    totalRows: 0,
    inlinePresentRows: 0,
    externalizedRows: 0,
    dualCopyRows: 0,
    blobOnlyRows: 0,
    inlineOnlyRows: 0,
    metadataInconsistentRows: 0,
    contractMismatchRows: 0,
    ledgerCoveredRows: 0,
    clearableRows: 0,
    clearableLedgerCoveredRows: 0,
    inlineBytesEstimated: 0,
    inlineSizeUnavailableRows: 0,
    batches: 0,
    truncated: false,
  };
}

/**
 * Classify one readiness row. A row is clearable only when it is externalized
 * with a supported contract, still carries inline content, and its externalized
 * timestamp is present; ledger coverage is tracked separately so the caller can
 * require full M4A ledger coverage before any inline clear.
 */
export function classifyArtifactReadinessRow(
  row: CaseBackfillArtifactReadinessRow,
): ArtifactReadinessClassification {
  const storageRef = nonEmptyText(row.storageRef);
  const contract = nonEmptyText(row.externalizationContractVersion);
  const externalized = storageRef !== null;
  const inlinePresent = row.inlinePresent === true;
  const contractPresent = contract !== null;
  const contractSupported = contract === ARTIFACT_BLOB_CONTRACT_VERSION;
  const externalizedAtPresent = row.externalizedAtPresent === true;

  const dualCopy = inlinePresent && externalized;
  const blobOnly = !inlinePresent && externalized;
  const inlineOnly = inlinePresent && !externalized;

  const metadataInconsistent =
    (externalized && (!contractPresent || !externalizedAtPresent))
    || (!externalized && (contractPresent || externalizedAtPresent));

  const contractMismatch = externalized && contractPresent && !contractSupported;
  const clearable = externalized && inlinePresent && externalizedAtPresent && contractSupported;

  const requiresContent = row.kind === "normalization" || row.replayability === "bounded_evidence";
  const forbidsContent = row.kind === "fetch"
    && (row.replayability === "full_snapshot" || row.replayability === "non_replayable");
  const contentMissing = requiresContent && !inlinePresent && !externalized;
  const contentUnexpected = forbidsContent && (inlinePresent || externalized);

  const rawSize = row.storedSize;
  const hasRecordedSize = typeof rawSize === "number" && Number.isInteger(rawSize) && rawSize >= 0;
  const recordedSize = inlinePresent && hasRecordedSize && !contentUnexpected && !metadataInconsistent
    ? rawSize
    : null;

  return {
    inlinePresent,
    externalized,
    dualCopy,
    blobOnly,
    inlineOnly,
    clearable,
    metadataInconsistent: metadataInconsistent || contentMissing || contentUnexpected,
    contractMismatch,
    ledgerCovered: row.ledgerCovered === true,
    recordedSize,
  };
}

function accumulateTotals(
  totals: ArtifactReadinessTotals,
  row: CaseBackfillArtifactReadinessRow,
  candidates: ArtifactVerificationCandidate[],
  verificationSampleSize: number,
) {
  const classification = classifyArtifactReadinessRow(row);
  totals.totalRows += 1;
  if (classification.inlinePresent) {
    totals.inlinePresentRows += 1;
    if (classification.recordedSize !== null) totals.inlineBytesEstimated += classification.recordedSize;
    else totals.inlineSizeUnavailableRows += 1;
  }
  if (classification.externalized) totals.externalizedRows += 1;
  if (classification.dualCopy) totals.dualCopyRows += 1;
  if (classification.blobOnly) totals.blobOnlyRows += 1;
  if (classification.inlineOnly) totals.inlineOnlyRows += 1;
  if (classification.metadataInconsistent) totals.metadataInconsistentRows += 1;
  if (classification.contractMismatch) totals.contractMismatchRows += 1;
  if (classification.externalized && classification.ledgerCovered) totals.ledgerCoveredRows += 1;
  if (classification.clearable) {
    totals.clearableRows += 1;
    if (classification.ledgerCovered) totals.clearableLedgerCoveredRows += 1;
  }
  if (
    verificationSampleSize > 0
    && candidates.length < verificationSampleSize
    && classification.externalized
  ) {
    const storageRef = nonEmptyText(row.storageRef);
    if (storageRef) {
      candidates.push({
        kind: row.kind,
        storageRef,
        expectedHash: row.storedHash,
        expectedSize: row.storedSize,
      });
    }
  }
}

function sumArtifactReadinessTotals(
  fetch: ArtifactReadinessTotals,
  normalization: ArtifactReadinessTotals,
): ArtifactReadinessTotals {
  return {
    totalRows: fetch.totalRows + normalization.totalRows,
    inlinePresentRows: fetch.inlinePresentRows + normalization.inlinePresentRows,
    externalizedRows: fetch.externalizedRows + normalization.externalizedRows,
    dualCopyRows: fetch.dualCopyRows + normalization.dualCopyRows,
    blobOnlyRows: fetch.blobOnlyRows + normalization.blobOnlyRows,
    inlineOnlyRows: fetch.inlineOnlyRows + normalization.inlineOnlyRows,
    metadataInconsistentRows: fetch.metadataInconsistentRows + normalization.metadataInconsistentRows,
    contractMismatchRows: fetch.contractMismatchRows + normalization.contractMismatchRows,
    ledgerCoveredRows: fetch.ledgerCoveredRows + normalization.ledgerCoveredRows,
    clearableRows: fetch.clearableRows + normalization.clearableRows,
    clearableLedgerCoveredRows: fetch.clearableLedgerCoveredRows + normalization.clearableLedgerCoveredRows,
    inlineBytesEstimated: fetch.inlineBytesEstimated + normalization.inlineBytesEstimated,
    inlineSizeUnavailableRows: fetch.inlineSizeUnavailableRows + normalization.inlineSizeUnavailableRows,
    batches: fetch.batches + normalization.batches,
    truncated: fetch.truncated || normalization.truncated,
  };
}

function emptyVerification(requested: boolean, sampleSize: number): ArtifactReadinessVerification {
  return {
    requested,
    sampleSize,
    candidatesConsidered: 0,
    sampled: 0,
    verifiedOk: 0,
    readErrors: 0,
    sizeMismatches: 0,
    hashMismatches: 0,
    invalidDocuments: 0,
    sampledByKind: { fetch: 0, normalization: 0 },
  };
}

function isJsonObject(bytes: Buffer) {
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

async function verifyArtifactReadinessSample(
  candidates: readonly ArtifactVerificationCandidate[],
  store: ArtifactBlobStore,
  limit: number,
): Promise<ArtifactReadinessVerification> {
  const verification = emptyVerification(true, limit);
  verification.candidatesConsidered = candidates.length;
  for (const candidate of candidates) {
    if (verification.sampled >= limit) break;
    verification.sampled += 1;
    verification.sampledByKind[candidate.kind] += 1;
    let headSize: number;
    try {
      headSize = (await store.head(candidate.storageRef)).size;
    } catch {
      verification.readErrors += 1;
      continue;
    }
    if (candidate.expectedSize !== null && headSize !== candidate.expectedSize) {
      verification.sizeMismatches += 1;
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await store.get(candidate.storageRef);
    } catch {
      verification.readErrors += 1;
      continue;
    }
    if (candidate.expectedSize !== null && bytes.byteLength !== candidate.expectedSize) {
      verification.sizeMismatches += 1;
      continue;
    }
    if (sha256Hex(bytes) !== candidate.expectedHash) {
      verification.hashMismatches += 1;
      continue;
    }
    if (!isJsonObject(bytes)) {
      verification.invalidDocuments += 1;
      continue;
    }
    verification.verifiedOk += 1;
  }
  return verification;
}

function buildArtifactReadinessGates(
  combined: ArtifactReadinessTotals,
  verification: ArtifactReadinessVerification,
  environment: Record<string, string | undefined>,
  uncoveredClearableKinds: readonly CaseBackfillArtifactExternalizationKind[],
): ArtifactReadinessGates {
  const readEnabled = caseBackfillArtifactBlobReadEnabled(environment);
  const writeEnabled = caseBackfillArtifactBlobWriteEnabled(environment);
  const flagErrors = caseBackfillArtifactBlobFlagErrors(environment);
  const readFlagReady = caseBackfillArtifactBlobReadReady(environment);
  const writeFlagReady = caseBackfillArtifactBlobWriteReady(environment);

  const metadataCritical = combined.metadataInconsistentRows > 0 || combined.contractMismatchRows > 0;
  const scanComplete = !combined.truncated;

  const verificationClean = verification.requested
    && verification.sampled > 0
    && verification.readErrors === 0
    && verification.sizeMismatches === 0
    && verification.hashMismatches === 0
    && verification.invalidDocuments === 0;

  // Every selected kind with clearable rows must appear in the verified sample.
  // The candidate list is bounded by `verificationSampleSize`, so a sample that
  // is too small to reach a clearable kind leaves it uncovered and blocks clear.
  const verificationKindCoverageReady = uncoveredClearableKinds.length === 0;
  const verificationReady = verificationClean && verificationKindCoverageReady;

  const ledgerCoverageReady = combined.clearableRows === 0
    || combined.clearableLedgerCoveredRows === combined.clearableRows;

  // NEW_WRITE_READY: read flag ready + write flag ready + no metadata criticals.
  const newWriteReady = readFlagReady && writeFlagReady && !metadataCritical && scanComplete;
  // INLINE_CLEAR_READY additionally requires a clean verified sample that covers
  // every clearable kind and full M4A ledger coverage for every row considered
  // clearable.
  const inlineClearReady = newWriteReady && ledgerCoverageReady && verificationReady;

  const critical = metadataCritical
    || verification.hashMismatches > 0
    || verification.sizeMismatches > 0
    || verification.invalidDocuments > 0;

  const blocking: string[] = [];
  if (!readEnabled) blocking.push("read_flag_disabled");
  if (!writeEnabled) blocking.push("write_flag_disabled");
  for (const error of flagErrors) blocking.push(error);
  if (!scanComplete) blocking.push("scan_truncated");
  if (combined.metadataInconsistentRows > 0) blocking.push("metadata_inconsistent_rows");
  if (combined.contractMismatchRows > 0) blocking.push("contract_mismatch_rows");
  if (!verification.requested) blocking.push("verification_not_requested");
  else if (verification.sampled === 0) blocking.push("verification_sample_empty");
  if (verification.readErrors > 0) blocking.push("blob_read_errors");
  if (verification.sizeMismatches > 0) blocking.push("blob_size_mismatches");
  if (verification.hashMismatches > 0) blocking.push("blob_hash_mismatches");
  if (verification.invalidDocuments > 0) blocking.push("blob_invalid_documents");
  for (const kind of uncoveredClearableKinds) {
    blocking.push(`verification_clearable_kind_unsampled_${kind}`);
  }
  if (!ledgerCoverageReady) blocking.push("ledger_coverage_incomplete");

  return {
    readEnabled,
    writeEnabled,
    writeWithoutRead: writeEnabled && !readEnabled,
    readFlagReady,
    writeFlagReady,
    flagErrors,
    scanComplete,
    metadataCritical,
    verificationRequested: verification.requested,
    verificationReady,
    verificationKindCoverageReady,
    ledgerCoverageReady,
    newWriteReady,
    inlineClearReady,
    critical,
    blocking,
  };
}

export async function runArtifactReadiness(
  input: CaseBackfillArtifactReadinessInput,
  dependencies: CaseBackfillArtifactReadinessDependencies,
): Promise<ArtifactReadinessReport> {
  const kinds = normalizeKinds(input.kinds);
  const batchSize = boundedInteger(input.batchSize, "batch_size", 1, ARTIFACT_READINESS_MAX_BATCH_SIZE);
  const maxBatches = boundedInteger(input.maxBatches, "max_batches", 1, ARTIFACT_READINESS_MAX_BATCHES);
  const verificationSampleSize = boundedInteger(
    input.verificationSampleSize ?? 0,
    "verification_sample_size",
    0,
    ARTIFACT_READINESS_MAX_VERIFICATION_SAMPLE,
  );
  const environment = dependencies.environment ?? process.env;
  const observedAt = (dependencies.now ?? (() => new Date()))().toISOString();

  const totalsByKind: Record<CaseBackfillArtifactExternalizationKind, ArtifactReadinessTotals> = {
    fetch: emptyArtifactReadinessTotals(),
    normalization: emptyArtifactReadinessTotals(),
  };
  const candidates: ArtifactVerificationCandidate[] = [];

  for (const kind of kinds) {
    const totals = totalsByKind[kind];
    let cursor = input.afterArtifactId ?? null;
    for (;;) {
      if (totals.batches >= maxBatches) {
        totals.truncated = true;
        break;
      }
      const rows = await dependencies.repository.listArtifactReadinessRows({
        kind,
        sourceKey: input.sourceKey ?? null,
        limit: batchSize,
        afterArtifactId: cursor,
      });
      if (rows.length === 0) break;
      totals.batches += 1;
      for (const row of rows) accumulateTotals(totals, row, candidates, verificationSampleSize);
      cursor = rows[rows.length - 1].artifactId;
      if (rows.length < batchSize) break;
    }
  }

  let verification: ArtifactReadinessVerification;
  if (verificationSampleSize > 0) {
    if (!dependencies.store) throw new Error("artifact_readiness.store_required");
    verification = await verifyArtifactReadinessSample(candidates, dependencies.store, verificationSampleSize);
  } else {
    verification = emptyVerification(false, 0);
  }

  const fetch = totalsByKind.fetch;
  const normalization = totalsByKind.normalization;
  const combined = sumArtifactReadinessTotals(fetch, normalization);
  const uncoveredClearableKinds = verification.requested
    ? kinds.filter((kind) => totalsByKind[kind].clearableRows > 0 && verification.sampledByKind[kind] === 0)
    : [];
  const gates = buildArtifactReadinessGates(combined, verification, environment, uncoveredClearableKinds);

  return {
    event: "artifact_blob_readiness",
    readOnly: true,
    machineReadable: true,
    observedAt,
    sourceKey: input.sourceKey ?? null,
    kinds: [...kinds],
    contractVersion: ARTIFACT_BLOB_CONTRACT_VERSION,
    writeFlagsDefaultOff: !gates.readEnabled && !gates.writeEnabled,
    inlineRestore: ARTIFACT_READINESS_INLINE_RESTORE,
    fetch,
    normalization,
    combined,
    verification,
    gates,
    decisions: {
      newWriteReady: gates.newWriteReady,
      inlineClearReady: gates.inlineClearReady,
    },
    blobObjectsDeleted: 0,
    publicCatalogWrites: 0,
    geminiCalls: 0,
    storageRefsEmitted: 0,
    perRowPayloadsEmitted: 0,
  };
}
