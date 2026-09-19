import { canonicalJson } from "@/lib/backfill/canonical-json";
import type { CaseBackfillRepository } from "@/lib/backfill/repository";
import { caseBackfillArtifactBlobReadReady } from "@/lib/backfill/flags";
import type {
  CaseBackfillArtifactExternalizationKind,
  CaseBackfillInlineRestoreCandidate,
} from "@/lib/backfill/types";
import {
  ARTIFACT_BLOB_CONTRACT_VERSION,
  ARTIFACT_BLOB_MAX_BYTES,
  buildArtifactStorageRef,
  sha256Hex,
  type ArtifactBlobStore,
} from "@/lib/storage/blob";

export interface CaseBackfillInlineRestoreDependencies {
  repository: Pick<
    CaseBackfillRepository,
    "listArtifactInlineRestoreCandidates" | "restoreArtifactInline"
  >;
  store?: ArtifactBlobStore | null;
  environment?: Record<string, string | undefined>;
}

export interface CaseBackfillInlineRestoreInput {
  kind: CaseBackfillArtifactExternalizationKind;
  sourceKey?: string | null;
  batchSize: number;
  afterArtifactId?: string | null;
  actorId: string;
  execute: boolean;
}

export interface CaseBackfillInlineRestorePlan {
  candidate: CaseBackfillInlineRestoreCandidate;
  storageRef: string;
  contentHash: string;
  contentSize: number;
}

export type CaseBackfillInlineRestoreStatus =
  | "planned"
  | "restored"
  | "idempotent"
  | "conflict"
  | "not_ready"
  | "failed";

export interface CaseBackfillInlineRestoreOutcome {
  artifactId: string;
  artifactTable: CaseBackfillInlineRestoreCandidate["artifactTable"];
  kind: CaseBackfillArtifactExternalizationKind;
  sourceKey: string;
  status: CaseBackfillInlineRestoreStatus;
  storageRef: string | null;
  contentHash: string | null;
  contentSize: number | null;
}

/**
 * CLI-safe projection: it exposes only status, artifact id, and size so no storage
 * ref, content hash, payload, token, or URL is ever written to stdout.
 */
export interface CaseBackfillInlineRestoreSafeOutcome {
  status: CaseBackfillInlineRestoreStatus;
  artifactId: string;
  contentSize: number | null;
}

export interface CaseBackfillInlineRestoreBatchResult {
  scanned: number;
  restored: number;
  idempotent: number;
  conflicts: number;
  notReady: number;
  failed: { artifactId: string; errorCode: string }[];
  outcomes: CaseBackfillInlineRestoreOutcome[];
  lastArtifactId: string | null;
}

export type CaseBackfillInlineRestoreClassification = "ready" | "conflict" | "not_ready";

function inlineRestoreErrorCode(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z][a-z0-9._-]{0,159}$/.test(value) ? value : "artifact_inline_restore.failed";
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function statusForErrorCode(errorCode: string): CaseBackfillInlineRestoreStatus {
  if (errorCode === "artifact_inline_restore.not_ready") return "not_ready";
  if (errorCode === "artifact_inline_restore.conflict") return "conflict";
  return "failed";
}

export function toSafeArtifactInlineRestoreOutcome(
  outcome: CaseBackfillInlineRestoreOutcome,
): CaseBackfillInlineRestoreSafeOutcome {
  return {
    status: outcome.status,
    artifactId: outcome.artifactId,
    contentSize: outcome.contentSize,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classify the candidate's externalization metadata before any Blob access. A
 * restore candidate is always a blob-only row, so there is nothing to compare
 * against; only the recorded metadata can be checked:
 *
 *   all five null (never externalized)                -> not_ready
 *   any partial value                                 -> conflict
 *   unsupported contract / blank or missing timestamp -> conflict
 *   malformed hash or non-integer size                -> conflict
 *   size above the 4 MiB bound                        -> conflict
 *   ref not content-addressed to source key + hash    -> conflict
 *   otherwise                                         -> ready
 *
 * The check is deliberately metadata-only: it never reads Blob and never compares
 * the recorded hash to any payload, because the Blob object is the only copy. A
 * divergence between the recorded metadata and the object is caught later by the
 * head/get size and SHA-256 checks before the RPC, and by the database-recomputed
 * byte length and SHA-256 inside the restore RPC.
 */
export function classifyArtifactInlineRestore(
  candidate: CaseBackfillInlineRestoreCandidate,
): CaseBackfillInlineRestoreClassification {
  const metadata = [
    candidate.storageRef,
    candidate.storedHash,
    candidate.storedSize,
    candidate.externalizedAt,
    candidate.externalizationContractVersion,
  ];
  const present = metadata.filter((value) => value !== null).length;
  if (present === 0) return "not_ready";
  if (present < metadata.length) return "conflict";
  if (candidate.externalizationContractVersion !== ARTIFACT_BLOB_CONTRACT_VERSION) return "conflict";
  if (typeof candidate.externalizedAt !== "string" || candidate.externalizedAt.trim() === "") {
    return "conflict";
  }
  if (typeof candidate.storedHash !== "string" || !SHA256_PATTERN.test(candidate.storedHash)) {
    return "conflict";
  }
  if (
    !Number.isInteger(candidate.storedSize)
    || (candidate.storedSize as number) < 0
    || (candidate.storedSize as number) > ARTIFACT_BLOB_MAX_BYTES
  ) {
    return "conflict";
  }
  let expectedRef: string;
  try {
    expectedRef = buildArtifactStorageRef(candidate.kind, candidate.sourceKey, candidate.storedHash);
  } catch {
    return "conflict";
  }
  if (candidate.storageRef !== expectedRef) return "conflict";
  return "ready";
}

/**
 * Revalidate the recorded externalization metadata and fail closed before any Blob
 * access or RPC. A missing (never externalized) row is `not_ready`; a partial or
 * conflicting metadata set is `conflict`.
 */
export function planArtifactInlineRestore(
  candidate: CaseBackfillInlineRestoreCandidate,
): CaseBackfillInlineRestorePlan {
  const classification = classifyArtifactInlineRestore(candidate);
  if (classification === "not_ready") throw new Error("artifact_inline_restore.not_ready");
  if (classification === "conflict") throw new Error("artifact_inline_restore.conflict");
  return {
    candidate,
    storageRef: candidate.storageRef as string,
    contentHash: candidate.storedHash as string,
    contentSize: candidate.storedSize as number,
  };
}

/**
 * Read flag gated restore: head the exact recorded size, get the exact byte length
 * and SHA-256, decode the stored document, require it to be a JSON object and to be
 * the exact canonical JSON the recorded hash covers, and only then call the restore
 * RPC with the parsed inline payload object, the canonical document, and the exact
 * recorded metadata. The RPC re-parses the document and requires it to equal the
 * payload, so the bytes that are hashed and the value that is written can never
 * disagree. Any Blob, read, hash, size, decode, canonicalization, or RPC failure
 * throws here, before the database is mutated. Blob objects are never written or
 * deleted.
 */
export async function restoreArtifactInlinePlan(
  plan: CaseBackfillInlineRestorePlan,
  dependencies: CaseBackfillInlineRestoreDependencies,
  actorId: string,
): Promise<CaseBackfillInlineRestoreOutcome> {
  const { candidate } = plan;
  const environment = dependencies.environment ?? process.env;
  if (!caseBackfillArtifactBlobReadReady(environment)) {
    throw new Error("artifact_inline_restore.read_disabled");
  }
  if (!dependencies.store) {
    throw new Error("artifact_inline_restore.store_unavailable");
  }
  const head = await dependencies.store.head(plan.storageRef);
  if (head.size !== plan.contentSize) {
    throw new Error("artifact_inline_restore.head_verification_failed");
  }
  const bytes = await dependencies.store.get(plan.storageRef);
  if (bytes.byteLength !== plan.contentSize || sha256Hex(bytes) !== plan.contentHash) {
    throw new Error("artifact_inline_restore.get_verification_failed");
  }
  const document = bytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    throw new Error("artifact_inline_restore.invalid_document");
  }
  if (!isRecord(parsed)) {
    throw new Error("artifact_inline_restore.invalid_document");
  }
  if (canonicalJson(parsed) !== document) {
    throw new Error("artifact_inline_restore.non_canonical_document");
  }
  const restored = await dependencies.repository.restoreArtifactInline({
    artifactTable: candidate.artifactTable,
    artifactId: candidate.artifactId,
    inlinePayload: parsed,
    document,
    storageRef: plan.storageRef,
    contentHash: plan.contentHash,
    contentSize: plan.contentSize,
    externalizationContractVersion: candidate.externalizationContractVersion as string,
    actorId,
  });
  return {
    artifactId: candidate.artifactId,
    artifactTable: candidate.artifactTable,
    kind: candidate.kind,
    sourceKey: candidate.sourceKey,
    status: restored.idempotent ? "idempotent" : "restored",
    storageRef: plan.storageRef,
    contentHash: plan.contentHash,
    contentSize: plan.contentSize,
  };
}

/**
 * One bounded batch. In dry-run mode it only plans and never reads Blob storage or
 * mutates the database, so it needs only the repository and works with no Blob
 * store (and therefore no Blob token). Execute mode requires the Blob read flag to
 * be ready and a Blob store before it lists anything, so it fails closed before any
 * store use or mutation on the first signature failure.
 */
export async function runArtifactInlineRestoreBatch(
  input: CaseBackfillInlineRestoreInput,
  dependencies: CaseBackfillInlineRestoreDependencies,
): Promise<CaseBackfillInlineRestoreBatchResult> {
  if (input.execute) {
    if (!caseBackfillArtifactBlobReadReady(dependencies.environment ?? process.env)) {
      throw new Error("artifact_inline_restore.read_disabled");
    }
    if (!dependencies.store) {
      throw new Error("artifact_inline_restore.store_unavailable");
    }
  }
  const candidates = await dependencies.repository.listArtifactInlineRestoreCandidates({
    kind: input.kind,
    sourceKey: input.sourceKey ?? null,
    limit: input.batchSize,
    afterArtifactId: input.afterArtifactId ?? null,
  });
  const outcomes: CaseBackfillInlineRestoreOutcome[] = [];
  const failed: { artifactId: string; errorCode: string }[] = [];
  let restored = 0;
  let idempotent = 0;
  let conflicts = 0;
  let notReady = 0;
  for (const candidate of candidates) {
    try {
      const plan = planArtifactInlineRestore(candidate);
      if (!input.execute) {
        outcomes.push({
          artifactId: candidate.artifactId,
          artifactTable: candidate.artifactTable,
          kind: candidate.kind,
          sourceKey: candidate.sourceKey,
          status: "planned",
          storageRef: plan.storageRef,
          contentHash: plan.contentHash,
          contentSize: plan.contentSize,
        });
        continue;
      }
      const outcome = await restoreArtifactInlinePlan(plan, dependencies, input.actorId);
      if (outcome.status === "idempotent") idempotent += 1;
      else restored += 1;
      outcomes.push(outcome);
    } catch (error) {
      const errorCode = inlineRestoreErrorCode(error);
      if (errorCode === "artifact_inline_restore.not_ready") notReady += 1;
      else if (errorCode === "artifact_inline_restore.conflict") conflicts += 1;
      failed.push({ artifactId: candidate.artifactId, errorCode });
      outcomes.push({
        artifactId: candidate.artifactId,
        artifactTable: candidate.artifactTable,
        kind: candidate.kind,
        sourceKey: candidate.sourceKey,
        status: statusForErrorCode(errorCode),
        storageRef: candidate.storageRef,
        contentHash: candidate.storedHash,
        contentSize: Number.isInteger(candidate.storedSize) ? candidate.storedSize : null,
      });
    }
  }
  return {
    scanned: candidates.length,
    restored,
    idempotent,
    conflicts,
    notReady,
    failed,
    outcomes,
    lastArtifactId: candidates.length > 0 ? candidates[candidates.length - 1].artifactId : null,
  };
}
