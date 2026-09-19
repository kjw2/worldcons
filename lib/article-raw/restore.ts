import {
  ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  ARTICLE_RAW_BLOB_MAX_BYTES,
  articleRawBlobStorageRef,
  decodeArticleRawText,
} from "@/lib/article-raw/codec";
import {
  ARTICLE_RAW_EXTERNALIZATION_TABLES,
  type ArticleRawExternalizationTable,
} from "@/lib/article-raw/externalization";
import { articleRawBlobReadReady } from "@/lib/article-raw/flags";
import { sha256Hex, type ArtifactBlobStore } from "@/lib/storage/blob";

/**
 * M6E article raw-text Blob inline restore.
 *
 * This is the safe rollback path for M6C: once the inline `raw_text` has been
 * cleared, the private content-addressed Blob object plus the append-only M6B
 * ledger row are the only copies. Restore puts the redundant inline copy back
 * through the single permit-guarded M6E transition.
 *
 * It reuses the M6A codec (`decodeArticleRawText`) and the M6A read flag, and it
 * mirrors the M6C candidate/classification shape. Every candidate is listed from the
 * M6E read-only authority, which already filters to rows with no inline `raw_text`,
 * and carries its five externalization metadata columns, so an incomplete or
 * conflicting metadata set is reported as `not_ready` / `conflict` before a single
 * byte is read from Blob and before any RPC is attempted.
 *
 * Execute mode verifies the object end to end before the DB is touched: head the
 * exact recorded size, get the exact byte length and SHA-256, and decode the stored
 * JSON string. The decoded text is then handed to the restore RPC, which recomputes
 * the JSON-string document size and SHA-256 server-side and requires them to equal
 * the recorded Blob size/hash. Blob objects are never written or deleted.
 */

export const ARTICLE_RAW_RESTORE_TABLES = ARTICLE_RAW_EXTERNALIZATION_TABLES;
export type ArticleRawRestoreTable = ArticleRawExternalizationTable;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface ArticleRawRestoreCandidate {
  articleTable: ArticleRawRestoreTable;
  articleRowId: string;
  sourceKey: string;
  rawTextStorageRef: string | null;
  rawTextBlobHash: string | null;
  rawTextBlobSize: number | null;
  rawTextExternalizedAt: string | null;
  rawTextBlobContractVersion: string | null;
}

export interface ListArticleRawRestoreCandidatesInput {
  articleTable: ArticleRawRestoreTable;
  sourceKey?: string | null;
  limit: number;
  afterArticleRowId?: string | null;
}

export interface RestoreArticleRawInlineInput {
  articleTable: ArticleRawRestoreTable;
  articleRowId: string;
  rawText: string;
  storageRef: string;
  contentHash: string;
  contentSize: number;
  externalizationContractVersion: string;
  actorId: string | null;
}

export interface RestoreArticleRawInlineResult {
  articleRowId: string;
  idempotent: boolean;
}

export interface ArticleRawRestoreRepository {
  listArticleRawRestoreCandidates(
    input: ListArticleRawRestoreCandidatesInput,
  ): Promise<ArticleRawRestoreCandidate[]>;
  restoreArticleRawInline(
    input: RestoreArticleRawInlineInput,
  ): Promise<RestoreArticleRawInlineResult>;
}

export interface ArticleRawRestoreDependencies {
  repository: ArticleRawRestoreRepository;
  /**
   * Optional Blob store. Dry-run never reads Blob, so it needs only the repository
   * and must work with no store (and therefore no Blob token). Execute mode requires
   * a non-null store and fails closed before listing if it is absent.
   */
  store?: ArtifactBlobStore | null;
  environment?: Record<string, string | undefined>;
}

export interface ArticleRawRestoreInput {
  articleTable: ArticleRawRestoreTable;
  sourceKey?: string | null;
  batchSize: number;
  afterArticleRowId?: string | null;
  actorId: string;
  execute: boolean;
}

export interface ArticleRawRestorePlan {
  candidate: ArticleRawRestoreCandidate;
  storageRef: string;
  contentHash: string;
  contentSize: number;
}

export type ArticleRawRestoreStatus =
  | "planned"
  | "restored"
  | "idempotent"
  | "conflict"
  | "not_ready"
  | "failed";

export interface ArticleRawRestoreOutcome {
  articleTable: ArticleRawRestoreTable;
  articleRowId: string;
  sourceKey: string;
  status: ArticleRawRestoreStatus;
  storageRef: string | null;
  contentHash: string | null;
  contentSize: number | null;
}

/**
 * CLI-safe projection: it exposes only status, row id, and size so no storage ref,
 * content hash, inline raw text, token, or URL is ever written to stdout.
 */
export interface ArticleRawRestoreSafeOutcome {
  status: ArticleRawRestoreStatus;
  articleRowId: string;
  contentSize: number | null;
}

export interface ArticleRawRestoreBatchResult {
  scanned: number;
  restored: number;
  idempotent: number;
  conflicts: number;
  notReady: number;
  failed: { articleRowId: string; errorCode: string }[];
  outcomes: ArticleRawRestoreOutcome[];
  lastArticleRowId: string | null;
}

export type ArticleRawRestoreClassification = "ready" | "conflict" | "not_ready";

function restoreErrorCode(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z][a-z0-9._-]{0,159}$/.test(value) ? value : "article_raw_restore.failed";
}

function statusForErrorCode(errorCode: string): ArticleRawRestoreStatus {
  if (errorCode === "article_raw_restore.not_ready") return "not_ready";
  if (errorCode === "article_raw_restore.conflict") return "conflict";
  return "failed";
}

export function toSafeArticleRawRestoreOutcome(
  outcome: ArticleRawRestoreOutcome,
): ArticleRawRestoreSafeOutcome {
  return {
    status: outcome.status,
    articleRowId: outcome.articleRowId,
    contentSize: outcome.contentSize,
  };
}

/**
 * Classify the row's five externalization metadata columns before any Blob access.
 * The candidate is always a blob-only row (no inline raw_text), so there is nothing
 * to compare against; only the recorded metadata can be checked:
 *
 *   all five null (never externalized)                -> not_ready
 *   any partial value                                 -> conflict
 *   unsupported contract / blank or missing timestamp -> conflict
 *   malformed hash or non-integer size                -> conflict
 *   size above the 4 MiB codec bound                  -> conflict
 *   ref not content-addressed to source key + hash    -> conflict
 *   otherwise                                         -> ready
 *
 * The check is deliberately metadata-only: it never reads Blob and never compares
 * the recorded hash to any payload, because the Blob object is the only copy. A
 * divergence between the recorded metadata and the object is caught later by the
 * head/get size and SHA-256 checks before the RPC, and by the DB-recomputed
 * JSON-string document size and SHA-256 inside the restore RPC.
 */
export function classifyArticleRawRestore(
  candidate: ArticleRawRestoreCandidate,
): ArticleRawRestoreClassification {
  const metadata = [
    candidate.rawTextStorageRef,
    candidate.rawTextBlobHash,
    candidate.rawTextBlobSize,
    candidate.rawTextExternalizedAt,
    candidate.rawTextBlobContractVersion,
  ];
  const present = metadata.filter((value) => value !== null).length;
  if (present === 0) return "not_ready";
  if (present < metadata.length) return "conflict";
  if (candidate.rawTextBlobContractVersion !== ARTICLE_RAW_BLOB_CONTRACT_VERSION) {
    return "conflict";
  }
  if (
    typeof candidate.rawTextExternalizedAt !== "string"
    || candidate.rawTextExternalizedAt.trim() === ""
  ) {
    return "conflict";
  }
  if (typeof candidate.rawTextBlobHash !== "string" || !SHA256_PATTERN.test(candidate.rawTextBlobHash)) {
    return "conflict";
  }
  if (
    !Number.isInteger(candidate.rawTextBlobSize)
    || (candidate.rawTextBlobSize as number) < 0
    || (candidate.rawTextBlobSize as number) > ARTICLE_RAW_BLOB_MAX_BYTES
  ) {
    return "conflict";
  }
  let expectedRef: string;
  try {
    expectedRef = articleRawBlobStorageRef(candidate.sourceKey, candidate.rawTextBlobHash);
  } catch {
    return "conflict";
  }
  if (candidate.rawTextStorageRef !== expectedRef) return "conflict";
  return "ready";
}

/**
 * Revalidate the recorded externalization metadata and fail closed before any Blob
 * access or RPC. A missing (never externalized) row is `not_ready`; a partial or
 * conflicting metadata set is `conflict`.
 */
export function planArticleRawRestore(
  candidate: ArticleRawRestoreCandidate,
): ArticleRawRestorePlan {
  const classification = classifyArticleRawRestore(candidate);
  if (classification === "not_ready") throw new Error("article_raw_restore.not_ready");
  if (classification === "conflict") throw new Error("article_raw_restore.conflict");
  return {
    candidate,
    storageRef: candidate.rawTextStorageRef as string,
    contentHash: candidate.rawTextBlobHash as string,
    contentSize: candidate.rawTextBlobSize as number,
  };
}

/**
 * Read-flag gated restore: head the exact recorded size, get the exact byte length
 * and SHA-256, and decode the stored JSON string. Only then is the restore RPC
 * called with the decoded text and the exact recorded metadata, so a Blob, read,
 * hash, size, or decode failure leaves the database untouched. Blob objects are
 * never written or deleted.
 */
export async function restoreArticleRawInlinePlan(
  plan: ArticleRawRestorePlan,
  dependencies: ArticleRawRestoreDependencies,
  actorId: string,
): Promise<ArticleRawRestoreOutcome> {
  const { candidate } = plan;
  const environment = dependencies.environment ?? process.env;
  if (!articleRawBlobReadReady(environment)) {
    throw new Error("article_raw_restore.read_disabled");
  }
  if (!dependencies.store) {
    throw new Error("article_raw_restore.store_unavailable");
  }
  const head = await dependencies.store.head(plan.storageRef);
  if (head.size !== plan.contentSize) {
    throw new Error("article_raw_restore.head_verification_failed");
  }
  const bytes = await dependencies.store.get(plan.storageRef);
  if (bytes.byteLength !== plan.contentSize || sha256Hex(bytes) !== plan.contentHash) {
    throw new Error("article_raw_restore.get_verification_failed");
  }
  let decoded: string;
  try {
    decoded = decodeArticleRawText(bytes);
  } catch {
    throw new Error("article_raw_restore.invalid_document");
  }
  const restored = await dependencies.repository.restoreArticleRawInline({
    articleTable: candidate.articleTable,
    articleRowId: candidate.articleRowId,
    rawText: decoded,
    storageRef: plan.storageRef,
    contentHash: plan.contentHash,
    contentSize: plan.contentSize,
    externalizationContractVersion: candidate.rawTextBlobContractVersion as string,
    actorId,
  });
  return {
    articleTable: candidate.articleTable,
    articleRowId: candidate.articleRowId,
    sourceKey: candidate.sourceKey,
    status: restored.idempotent ? "idempotent" : "restored",
    storageRef: plan.storageRef,
    contentHash: plan.contentHash,
    contentSize: plan.contentSize,
  };
}

/**
 * One bounded batch. In dry-run mode it only classifies and plans and never reads
 * Blob storage or mutates the database; it needs only the repository and works with
 * no Blob store. Execute mode requires the Blob read flag to be ready and a Blob
 * store before it lists anything, so it fails closed before any store use or
 * mutation on the first signature failure.
 */
export async function runArticleRawRestoreBatch(
  input: ArticleRawRestoreInput,
  dependencies: ArticleRawRestoreDependencies,
): Promise<ArticleRawRestoreBatchResult> {
  if (input.execute) {
    if (!articleRawBlobReadReady(dependencies.environment ?? process.env)) {
      throw new Error("article_raw_restore.read_disabled");
    }
    if (!dependencies.store) {
      throw new Error("article_raw_restore.store_unavailable");
    }
  }
  const candidates = await dependencies.repository.listArticleRawRestoreCandidates({
    articleTable: input.articleTable,
    sourceKey: input.sourceKey ?? null,
    limit: input.batchSize,
    afterArticleRowId: input.afterArticleRowId ?? null,
  });
  const outcomes: ArticleRawRestoreOutcome[] = [];
  const failed: { articleRowId: string; errorCode: string }[] = [];
  let restored = 0;
  let idempotent = 0;
  let conflicts = 0;
  let notReady = 0;
  for (const candidate of candidates) {
    try {
      const plan = planArticleRawRestore(candidate);
      if (!input.execute) {
        outcomes.push({
          articleTable: candidate.articleTable,
          articleRowId: candidate.articleRowId,
          sourceKey: candidate.sourceKey,
          status: "planned",
          storageRef: plan.storageRef,
          contentHash: plan.contentHash,
          contentSize: plan.contentSize,
        });
        continue;
      }
      const outcome = await restoreArticleRawInlinePlan(plan, dependencies, input.actorId);
      if (outcome.status === "idempotent") idempotent += 1;
      else restored += 1;
      outcomes.push(outcome);
    } catch (error) {
      const errorCode = restoreErrorCode(error);
      if (errorCode === "article_raw_restore.not_ready") notReady += 1;
      else if (errorCode === "article_raw_restore.conflict") conflicts += 1;
      failed.push({ articleRowId: candidate.articleRowId, errorCode });
      outcomes.push({
        articleTable: candidate.articleTable,
        articleRowId: candidate.articleRowId,
        sourceKey: candidate.sourceKey,
        status: statusForErrorCode(errorCode),
        storageRef: candidate.rawTextStorageRef,
        contentHash: candidate.rawTextBlobHash,
        contentSize: Number.isInteger(candidate.rawTextBlobSize) ? candidate.rawTextBlobSize : null,
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
    lastArticleRowId: candidates.length > 0 ? candidates[candidates.length - 1].articleRowId : null,
  };
}
