import type { CaseBackfillRepository } from "@/lib/backfill/repository";
import { caseBackfillArtifactBlobReadReady } from "@/lib/backfill/flags";
import type {
  CaseBackfillArtifactExternalizationKind,
  CaseBackfillInlineClearCandidate,
} from "@/lib/backfill/types";
import {
  ARTIFACT_BLOB_CONTRACT_VERSION,
  buildArtifactStorageRef,
  sha256Hex,
  type ArtifactBlobStore,
} from "@/lib/storage/blob";

export interface CaseBackfillInlineClearDependencies {
  repository: Pick<
    CaseBackfillRepository,
    "listArtifactInlineClearCandidates" | "clearArtifactInline"
  >;
  store: ArtifactBlobStore;
  environment?: Record<string, string | undefined>;
}

export interface CaseBackfillInlineClearInput {
  kind: CaseBackfillArtifactExternalizationKind;
  sourceKey?: string | null;
  batchSize: number;
  afterArtifactId?: string | null;
  actorId: string;
  execute: boolean;
}

export interface CaseBackfillInlineClearPlan {
  candidate: CaseBackfillInlineClearCandidate;
  storageRef: string;
  contentHash: string;
  contentSize: number;
}

export interface CaseBackfillInlineClearOutcome {
  artifactId: string;
  artifactTable: CaseBackfillInlineClearCandidate["artifactTable"];
  kind: CaseBackfillArtifactExternalizationKind;
  sourceKey: string;
  status: "planned" | "cleared" | "idempotent";
  storageRef: string;
  contentHash: string;
  contentSize: number;
}

export interface CaseBackfillInlineClearBatchResult {
  scanned: number;
  cleared: number;
  idempotent: number;
  failed: { artifactId: string; errorCode: string }[];
  outcomes: CaseBackfillInlineClearOutcome[];
  lastArtifactId: string | null;
}

function inlineClearErrorCode(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z][a-z0-9._-]{0,159}$/.test(value) ? value : "artifact_inline_clear.failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Revalidate the recorded externalization metadata before any Blob access: the
 * contract must be exactly the supported version, the storage ref must be the
 * content-addressed ref for this artifact's own source key and hash, and the
 * recorded byte size must be present. Any divergence fails closed.
 */
export function planArtifactInlineClear(
  candidate: CaseBackfillInlineClearCandidate,
): CaseBackfillInlineClearPlan {
  if (candidate.externalizationContractVersion !== ARTIFACT_BLOB_CONTRACT_VERSION) {
    throw new Error("artifact_inline_clear.contract_unsupported");
  }
  const expectedRef = buildArtifactStorageRef(candidate.kind, candidate.sourceKey, candidate.storedHash);
  if (candidate.storageRef !== expectedRef) {
    throw new Error("artifact_inline_clear.storage_ref_mismatch");
  }
  if (!Number.isInteger(candidate.storedSize) || candidate.storedSize < 0) {
    throw new Error("artifact_inline_clear.size_missing");
  }
  return {
    candidate,
    storageRef: candidate.storageRef,
    contentHash: candidate.storedHash,
    contentSize: candidate.storedSize,
  };
}

/**
 * Read flag gated clear: head and get the externalized object, verify the exact
 * recorded size and SHA-256 against the DB/ledger values, require valid JSON
 * object content, and only then call the clear RPC. Any Blob, read, hash, size,
 * contract, ledger, or content failure throws here, before the DB is mutated.
 * Blob objects are never deleted.
 */
export async function clearArtifactInlinePlan(
  plan: CaseBackfillInlineClearPlan,
  dependencies: CaseBackfillInlineClearDependencies,
  actorId: string,
): Promise<CaseBackfillInlineClearOutcome> {
  const { candidate } = plan;
  const environment = dependencies.environment ?? process.env;
  if (!caseBackfillArtifactBlobReadReady(environment)) {
    throw new Error("artifact_inline_clear.read_disabled");
  }
  const head = await dependencies.store.head(plan.storageRef);
  if (head.size !== plan.contentSize) {
    throw new Error("artifact_inline_clear.head_verification_failed");
  }
  const bytes = await dependencies.store.get(plan.storageRef);
  if (bytes.byteLength !== plan.contentSize || sha256Hex(bytes) !== plan.contentHash) {
    throw new Error("artifact_inline_clear.get_verification_failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("artifact_inline_clear.invalid_document");
  }
  if (!isRecord(parsed)) {
    throw new Error("artifact_inline_clear.invalid_document");
  }
  const cleared = await dependencies.repository.clearArtifactInline({
    artifactTable: candidate.artifactTable,
    artifactId: candidate.artifactId,
    expectedStorageRef: plan.storageRef,
    expectedContentHash: plan.contentHash,
    expectedContentSize: plan.contentSize,
    externalizationContractVersion: candidate.externalizationContractVersion,
    actorId,
  });
  return {
    artifactId: candidate.artifactId,
    artifactTable: candidate.artifactTable,
    kind: candidate.kind,
    sourceKey: candidate.sourceKey,
    status: cleared.idempotent ? "idempotent" : "cleared",
    storageRef: plan.storageRef,
    contentHash: plan.contentHash,
    contentSize: plan.contentSize,
  };
}

/**
 * One bounded batch. In dry-run mode it only plans and never reads Blob storage or
 * mutates the database. Execute mode requires the Blob read flag to be ready and
 * fails closed before any mutation on the first signature failure.
 */
export async function runArtifactInlineClearBatch(
  input: CaseBackfillInlineClearInput,
  dependencies: CaseBackfillInlineClearDependencies,
): Promise<CaseBackfillInlineClearBatchResult> {
  if (input.execute && !caseBackfillArtifactBlobReadReady(dependencies.environment ?? process.env)) {
    throw new Error("artifact_inline_clear.read_disabled");
  }
  const candidates = await dependencies.repository.listArtifactInlineClearCandidates({
    kind: input.kind,
    sourceKey: input.sourceKey ?? null,
    limit: input.batchSize,
    afterArtifactId: input.afterArtifactId ?? null,
  });
  const outcomes: CaseBackfillInlineClearOutcome[] = [];
  const failed: { artifactId: string; errorCode: string }[] = [];
  let cleared = 0;
  let idempotent = 0;
  for (const candidate of candidates) {
    try {
      const plan = planArtifactInlineClear(candidate);
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
      const outcome = await clearArtifactInlinePlan(plan, dependencies, input.actorId);
      if (outcome.status === "idempotent") idempotent += 1;
      else cleared += 1;
      outcomes.push(outcome);
    } catch (error) {
      failed.push({ artifactId: candidate.artifactId, errorCode: inlineClearErrorCode(error) });
    }
  }
  return {
    scanned: candidates.length,
    cleared,
    idempotent,
    failed,
    outcomes,
    lastArtifactId: candidates.length > 0 ? candidates[candidates.length - 1].artifactId : null,
  };
}
