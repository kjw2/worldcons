import { canonicalJson } from "@/lib/backfill/canonical-json";
import type { CaseBackfillRepository } from "@/lib/backfill/repository";
import type {
  CaseBackfillArtifactExternalizationKind,
  CaseBackfillExternalizationCandidate,
} from "@/lib/backfill/types";
import {
  buildArtifactStorageRef,
  sha256Hex,
  type ArtifactBlobStore,
} from "@/lib/storage/blob";

export interface CaseBackfillExternalizationDependencies {
  repository: Pick<
    CaseBackfillRepository,
    "listArtifactExternalizationCandidates" | "attachArtifactExternalization"
  >;
  store: ArtifactBlobStore;
}

export interface CaseBackfillExternalizationInput {
  kind: CaseBackfillArtifactExternalizationKind;
  sourceKey?: string | null;
  batchSize: number;
  afterArtifactId?: string | null;
  actorId: string;
  execute: boolean;
}

export interface CaseBackfillExternalizationPlan {
  candidate: CaseBackfillExternalizationCandidate;
  document: string;
  contentHash: string;
  contentSize: number;
}

export interface CaseBackfillExternalizationOutcome {
  artifactId: string;
  artifactTable: CaseBackfillExternalizationCandidate["artifactTable"];
  kind: CaseBackfillArtifactExternalizationKind;
  sourceKey: string;
  status: "planned" | "externalized" | "idempotent";
  storageRef: string;
  contentHash: string;
  contentSize: number;
}

export interface CaseBackfillExternalizationBatchResult {
  scanned: number;
  externalized: number;
  idempotent: number;
  failed: { artifactId: string; errorCode: string }[];
  outcomes: CaseBackfillExternalizationOutcome[];
  lastArtifactId: string | null;
}

function externalizationErrorCode(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z][a-z0-9._-]{0,159}$/.test(value) ? value : "artifact_externalization.failed";
}

/**
 * Rebuild the artifact document with the same canonical JSON + SHA-256 semantics
 * the write path recorded, and fail closed on any hash or size divergence before
 * a single byte is uploaded.
 */
export function planArtifactExternalization(
  candidate: CaseBackfillExternalizationCandidate,
): CaseBackfillExternalizationPlan {
  if (!candidate.inlinePayload || typeof candidate.inlinePayload !== "object") {
    throw new Error("artifact_externalization.inline_payload_missing");
  }
  const document = canonicalJson(candidate.inlinePayload);
  const contentHash = sha256Hex(document);
  if (contentHash !== candidate.storedHash) {
    throw new Error("artifact_externalization.hash_mismatch");
  }
  const contentSize = Buffer.byteLength(document, "utf8");
  if (candidate.storedSize !== null && candidate.storedSize !== contentSize) {
    throw new Error("artifact_externalization.size_mismatch");
  }
  return { candidate, document, contentHash, contentSize };
}

/**
 * Upload the artifact document through ArtifactBlobStore, then head/get and
 * verify size and SHA-256. Any Blob or verification failure throws here, before
 * the repository attach RPC is ever called, so the DB stays untouched.
 */
export async function externalizeArtifactPlan(
  plan: CaseBackfillExternalizationPlan,
  dependencies: CaseBackfillExternalizationDependencies,
  actorId: string,
): Promise<CaseBackfillExternalizationOutcome> {
  const { candidate } = plan;
  const bytes = Buffer.from(plan.document, "utf8");
  const uploaded = await dependencies.store.put({
    kind: candidate.kind,
    sourceKey: candidate.sourceKey,
    bytes,
  });
  if (uploaded.sha256 !== plan.contentHash || uploaded.size !== plan.contentSize) {
    throw new Error("artifact_externalization.upload_verification_failed");
  }
  const head = await dependencies.store.head(uploaded.storageRef);
  if (head.size !== plan.contentSize) {
    throw new Error("artifact_externalization.head_verification_failed");
  }
  const stored = await dependencies.store.get(uploaded.storageRef);
  if (stored.byteLength !== plan.contentSize || sha256Hex(stored) !== plan.contentHash) {
    throw new Error("artifact_externalization.get_verification_failed");
  }
  const attached = await dependencies.repository.attachArtifactExternalization({
    artifactTable: candidate.artifactTable,
    artifactId: candidate.artifactId,
    storageRef: uploaded.storageRef,
    contentHash: plan.contentHash,
    contentSize: plan.contentSize,
    externalizationContractVersion: uploaded.contractVersion,
    actorId,
  });
  return {
    artifactId: candidate.artifactId,
    artifactTable: candidate.artifactTable,
    kind: candidate.kind,
    sourceKey: candidate.sourceKey,
    status: attached.idempotent ? "idempotent" : "externalized",
    storageRef: uploaded.storageRef,
    contentHash: plan.contentHash,
    contentSize: plan.contentSize,
  };
}

/** One bounded batch. In dry-run mode it only plans and never uploads or mutates. */
export async function runArtifactExternalizationBatch(
  input: CaseBackfillExternalizationInput,
  dependencies: CaseBackfillExternalizationDependencies,
): Promise<CaseBackfillExternalizationBatchResult> {
  const candidates = await dependencies.repository.listArtifactExternalizationCandidates({
    kind: input.kind,
    sourceKey: input.sourceKey ?? null,
    limit: input.batchSize,
    afterArtifactId: input.afterArtifactId ?? null,
  });
  const outcomes: CaseBackfillExternalizationOutcome[] = [];
  const failed: { artifactId: string; errorCode: string }[] = [];
  let externalized = 0;
  let idempotent = 0;
  for (const candidate of candidates) {
    try {
      const plan = planArtifactExternalization(candidate);
      if (!input.execute) {
        outcomes.push({
          artifactId: candidate.artifactId,
          artifactTable: candidate.artifactTable,
          kind: candidate.kind,
          sourceKey: candidate.sourceKey,
          status: "planned",
          storageRef: buildArtifactStorageRef(candidate.kind, candidate.sourceKey, plan.contentHash),
          contentHash: plan.contentHash,
          contentSize: plan.contentSize,
        });
        continue;
      }
      const outcome = await externalizeArtifactPlan(plan, dependencies, input.actorId);
      if (outcome.status === "idempotent") idempotent += 1;
      else externalized += 1;
      outcomes.push(outcome);
    } catch (error) {
      failed.push({ artifactId: candidate.artifactId, errorCode: externalizationErrorCode(error) });
    }
  }
  return {
    scanned: candidates.length,
    externalized,
    idempotent,
    failed,
    outcomes,
    lastArtifactId: candidates.length > 0 ? candidates[candidates.length - 1].artifactId : null,
  };
}
