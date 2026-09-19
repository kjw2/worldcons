import {
  ARTICLE_RAW_BLOB_CONTRACT_VERSION,
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
 * M6C article raw-text Blob inline clear.
 *
 * This is the article analogue of the M4B artifact inline clear: after M6A has
 * attached the verified content-addressed raw-text Blob metadata and M6B has
 * recorded the append-only externalization ledger entry, drop the now-redundant
 * inline `raw_text` copy through the single permit-guarded M6C transition.
 *
 * It reuses the M6A codec (`decodeArticleRawText`) and the M6A read flag, and it
 * mirrors the M6B candidate/classification shape. Every candidate carries its five
 * externalization metadata columns, so an incomplete or conflicting metadata set is
 * reported as `not_ready` / `metadata_conflict` before a single byte is read from
 * Blob and before any RPC is attempted.
 *
 * Execute mode verifies the object end to end before the DB is touched: head the
 * exact recorded size, get the exact byte length and SHA-256, decode the stored JSON
 * string, and require the decoded text to equal the row's current inline `raw_text`
 * exactly. Only then does the repository call `article_raw_inline_clear_v1` with
 * `p_dry_run = false`. Blob objects are never written or deleted.
 */

export const ARTICLE_RAW_INLINE_CLEAR_TABLES = ARTICLE_RAW_EXTERNALIZATION_TABLES;
export type ArticleRawInlineClearTable = ArticleRawExternalizationTable;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface ArticleRawInlineClearCandidate {
  articleTable: ArticleRawInlineClearTable;
  articleRowId: string;
  sourceKey: string;
  rawText: string;
  rawTextStorageRef: string | null;
  rawTextBlobHash: string | null;
  rawTextBlobSize: number | null;
  rawTextExternalizedAt: string | null;
  rawTextBlobContractVersion: string | null;
}

export interface ListArticleRawInlineClearCandidatesInput {
  articleTable: ArticleRawInlineClearTable;
  sourceKey?: string | null;
  limit: number;
  afterArticleRowId?: string | null;
}

export interface ClearArticleRawInlineInput {
  articleTable: ArticleRawInlineClearTable;
  articleRowId: string;
  expectedStorageRef: string;
  expectedContentHash: string;
  expectedContentSize: number;
  externalizationContractVersion: string;
  actorId: string | null;
}

export interface ClearArticleRawInlineResult {
  articleRowId: string;
  idempotent: boolean;
}

export interface ArticleRawInlineClearRepository {
  listArticleRawInlineClearCandidates(
    input: ListArticleRawInlineClearCandidatesInput,
  ): Promise<ArticleRawInlineClearCandidate[]>;
  clearArticleRawInline(input: ClearArticleRawInlineInput): Promise<ClearArticleRawInlineResult>;
}

export interface ArticleRawInlineClearDependencies {
  repository: ArticleRawInlineClearRepository;
  store: ArtifactBlobStore;
  environment?: Record<string, string | undefined>;
}

export interface ArticleRawInlineClearInput {
  articleTable: ArticleRawInlineClearTable;
  sourceKey?: string | null;
  batchSize: number;
  afterArticleRowId?: string | null;
  actorId: string;
  execute: boolean;
}

export interface ArticleRawInlineClearPlan {
  candidate: ArticleRawInlineClearCandidate;
  storageRef: string;
  contentHash: string;
  contentSize: number;
}

export type ArticleRawInlineClearStatus =
  | "planned"
  | "cleared"
  | "idempotent"
  | "metadata_conflict"
  | "not_ready"
  | "failed";

export interface ArticleRawInlineClearOutcome {
  articleTable: ArticleRawInlineClearTable;
  articleRowId: string;
  sourceKey: string;
  status: ArticleRawInlineClearStatus;
  storageRef: string | null;
  contentHash: string | null;
  contentSize: number | null;
}

/**
 * CLI-safe projection: it exposes only status, row id, and size so no storage ref,
 * content hash, inline raw text, token, or URL is ever written to stdout.
 */
export interface ArticleRawInlineClearSafeOutcome {
  status: ArticleRawInlineClearStatus;
  articleRowId: string;
  contentSize: number | null;
}

export interface ArticleRawInlineClearBatchResult {
  scanned: number;
  cleared: number;
  idempotent: number;
  conflicts: number;
  notReady: number;
  failed: { articleRowId: string; errorCode: string }[];
  outcomes: ArticleRawInlineClearOutcome[];
  lastArticleRowId: string | null;
}

export type ArticleRawInlineClearClassification = "ready" | "metadata_conflict" | "not_ready";

function inlineClearErrorCode(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z][a-z0-9._-]{0,159}$/.test(value) ? value : "article_raw_inline_clear.failed";
}

function statusForErrorCode(errorCode: string): ArticleRawInlineClearStatus {
  if (errorCode === "article_raw_inline_clear.not_ready") return "not_ready";
  if (errorCode === "article_raw_inline_clear.metadata_conflict") return "metadata_conflict";
  return "failed";
}

export function toSafeArticleRawInlineClearOutcome(
  outcome: ArticleRawInlineClearOutcome,
): ArticleRawInlineClearSafeOutcome {
  return {
    status: outcome.status,
    articleRowId: outcome.articleRowId,
    contentSize: outcome.contentSize,
  };
}

/**
 * Classify the row's five externalization metadata columns before any Blob access:
 *
 *   no inline raw_text                                -> not_ready
 *   all five null (never externalized)                -> not_ready
 *   any partial value                                 -> metadata_conflict
 *   unsupported contract / blank or missing timestamp -> metadata_conflict
 *   malformed hash or non-integer size                -> metadata_conflict
 *   ref not content-addressed to source key + hash    -> metadata_conflict
 *   otherwise                                         -> ready
 *
 * The check is deliberately metadata-only: it never reads Blob and never compares
 * the recorded hash to the inline text, because the Blob payload may legitimately
 * lag the inline value. That divergence is caught later by the decoded-text
 * equality check before the RPC, which is what keeps a stale object from clearing
 * newer inline content.
 */
export function classifyArticleRawInlineClear(
  candidate: ArticleRawInlineClearCandidate,
): ArticleRawInlineClearClassification {
  if (typeof candidate.rawText !== "string") return "not_ready";
  const metadata = [
    candidate.rawTextStorageRef,
    candidate.rawTextBlobHash,
    candidate.rawTextBlobSize,
    candidate.rawTextExternalizedAt,
    candidate.rawTextBlobContractVersion,
  ];
  const present = metadata.filter((value) => value !== null).length;
  if (present === 0) return "not_ready";
  if (present < metadata.length) return "metadata_conflict";
  if (candidate.rawTextBlobContractVersion !== ARTICLE_RAW_BLOB_CONTRACT_VERSION) {
    return "metadata_conflict";
  }
  if (
    typeof candidate.rawTextExternalizedAt !== "string"
    || candidate.rawTextExternalizedAt.trim() === ""
  ) {
    return "metadata_conflict";
  }
  if (typeof candidate.rawTextBlobHash !== "string" || !SHA256_PATTERN.test(candidate.rawTextBlobHash)) {
    return "metadata_conflict";
  }
  if (!Number.isInteger(candidate.rawTextBlobSize) || (candidate.rawTextBlobSize as number) < 0) {
    return "metadata_conflict";
  }
  let expectedRef: string;
  try {
    expectedRef = articleRawBlobStorageRef(candidate.sourceKey, candidate.rawTextBlobHash);
  } catch {
    return "metadata_conflict";
  }
  if (candidate.rawTextStorageRef !== expectedRef) return "metadata_conflict";
  return "ready";
}

/**
 * Revalidate the recorded externalization metadata and fail closed before any Blob
 * access or RPC. A missing (never externalized) row is `not_ready`; a partial or
 * conflicting metadata set is `metadata_conflict`.
 */
export function planArticleRawInlineClear(
  candidate: ArticleRawInlineClearCandidate,
): ArticleRawInlineClearPlan {
  if (typeof candidate.rawText !== "string") {
    throw new Error("article_raw_inline_clear.inline_missing");
  }
  const classification = classifyArticleRawInlineClear(candidate);
  if (classification === "not_ready") throw new Error("article_raw_inline_clear.not_ready");
  if (classification === "metadata_conflict") {
    throw new Error("article_raw_inline_clear.metadata_conflict");
  }
  return {
    candidate,
    storageRef: candidate.rawTextStorageRef as string,
    contentHash: candidate.rawTextBlobHash as string,
    contentSize: candidate.rawTextBlobSize as number,
  };
}

/**
 * Read-flag gated clear: head the exact recorded size, get the exact byte length and
 * SHA-256, decode the stored JSON string, and require the decoded text to equal the
 * row's current inline `raw_text` exactly. Only then is the clear RPC called, so a
 * Blob, read, hash, size, decode, or text failure leaves the inline copy untouched.
 * Blob objects are never written or deleted.
 */
export async function clearArticleRawInlinePlan(
  plan: ArticleRawInlineClearPlan,
  dependencies: ArticleRawInlineClearDependencies,
  actorId: string,
): Promise<ArticleRawInlineClearOutcome> {
  const { candidate } = plan;
  const environment = dependencies.environment ?? process.env;
  if (!articleRawBlobReadReady(environment)) {
    throw new Error("article_raw_inline_clear.read_disabled");
  }
  const head = await dependencies.store.head(plan.storageRef);
  if (head.size !== plan.contentSize) {
    throw new Error("article_raw_inline_clear.head_verification_failed");
  }
  const bytes = await dependencies.store.get(plan.storageRef);
  if (bytes.byteLength !== plan.contentSize || sha256Hex(bytes) !== plan.contentHash) {
    throw new Error("article_raw_inline_clear.get_verification_failed");
  }
  let decoded: string;
  try {
    decoded = decodeArticleRawText(bytes);
  } catch {
    throw new Error("article_raw_inline_clear.invalid_document");
  }
  if (decoded !== candidate.rawText) {
    throw new Error("article_raw_inline_clear.text_mismatch");
  }
  const cleared = await dependencies.repository.clearArticleRawInline({
    articleTable: candidate.articleTable,
    articleRowId: candidate.articleRowId,
    expectedStorageRef: plan.storageRef,
    expectedContentHash: plan.contentHash,
    expectedContentSize: plan.contentSize,
    externalizationContractVersion: candidate.rawTextBlobContractVersion as string,
    actorId,
  });
  return {
    articleTable: candidate.articleTable,
    articleRowId: candidate.articleRowId,
    sourceKey: candidate.sourceKey,
    status: cleared.idempotent ? "idempotent" : "cleared",
    storageRef: plan.storageRef,
    contentHash: plan.contentHash,
    contentSize: plan.contentSize,
  };
}

/**
 * One bounded batch. In dry-run mode it only classifies and plans and never reads
 * Blob storage or mutates the database. Execute mode requires the Blob read flag to
 * be ready and fails closed before any mutation on the first signature failure.
 */
export async function runArticleRawInlineClearBatch(
  input: ArticleRawInlineClearInput,
  dependencies: ArticleRawInlineClearDependencies,
): Promise<ArticleRawInlineClearBatchResult> {
  if (input.execute && !articleRawBlobReadReady(dependencies.environment ?? process.env)) {
    throw new Error("article_raw_inline_clear.read_disabled");
  }
  const candidates = await dependencies.repository.listArticleRawInlineClearCandidates({
    articleTable: input.articleTable,
    sourceKey: input.sourceKey ?? null,
    limit: input.batchSize,
    afterArticleRowId: input.afterArticleRowId ?? null,
  });
  const outcomes: ArticleRawInlineClearOutcome[] = [];
  const failed: { articleRowId: string; errorCode: string }[] = [];
  let cleared = 0;
  let idempotent = 0;
  let conflicts = 0;
  let notReady = 0;
  for (const candidate of candidates) {
    try {
      const plan = planArticleRawInlineClear(candidate);
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
      const outcome = await clearArticleRawInlinePlan(plan, dependencies, input.actorId);
      if (outcome.status === "idempotent") idempotent += 1;
      else cleared += 1;
      outcomes.push(outcome);
    } catch (error) {
      const errorCode = inlineClearErrorCode(error);
      if (errorCode === "article_raw_inline_clear.not_ready") notReady += 1;
      else if (errorCode === "article_raw_inline_clear.metadata_conflict") conflicts += 1;
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
    cleared,
    idempotent,
    conflicts,
    notReady,
    failed,
    outcomes,
    lastArticleRowId: candidates.length > 0 ? candidates[candidates.length - 1].articleRowId : null,
  };
}
