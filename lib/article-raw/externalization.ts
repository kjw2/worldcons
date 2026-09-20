import {
  ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  articleRawBlobStorageRef,
  decodeArticleRawText,
  encodeArticleRawText,
} from "@/lib/article-raw/codec";
import { sha256Hex, type ArtifactBlobStore } from "@/lib/storage/blob";

/**
 * M6B article raw-text Blob externalization backfill.
 *
 * This is the article analogue of the M4A artifact externalization: it attaches a
 * verified private Blob ref to an existing inline `raw_text` row on `articles` /
 * `article_content_versions_p3` while preserving the inline copy. It reuses the M6A
 * codec (`encodeArticleRawText`) for the deterministic JSON string document and the
 * shared `ArtifactBlobStore` for the content-addressed object, and it fails closed
 * before any DB mutation on any codec, upload, head, get, size, hash, or decode
 * divergence.
 *
 * Every candidate carries its five externalization metadata columns so the service
 * can classify it before any upload: an all-null row is still `pending`, an exact
 * five-column match is already `idempotent`, and any partial or conflicting state
 * is a `metadata_conflict` that performs zero put and zero attach.
 *
 * The attach itself is the single permit-guarded transition in the M6B migration;
 * this module never clears inline content and never re-points an externalized row.
 */

export const ARTICLE_RAW_EXTERNALIZATION_TABLES = [
  "articles",
  "article_content_versions_p3",
] as const;
export type ArticleRawExternalizationTable = (typeof ARTICLE_RAW_EXTERNALIZATION_TABLES)[number];

export interface ArticleRawExternalizationCandidate {
  articleTable: ArticleRawExternalizationTable;
  articleRowId: string;
  articleId: string;
  sourceKey: string;
  rawText: string;
  rawTextStorageRef: string | null;
  rawTextBlobHash: string | null;
  rawTextBlobSize: number | null;
  rawTextExternalizedAt: string | null;
  rawTextBlobContractVersion: string | null;
}
export interface ListArticleRawExternalizationCandidatesInput {
  articleTable: ArticleRawExternalizationTable;
  sourceKey?: string | null;
  limit: number;
  afterArticleRowId?: string | null;
}

export interface AttachArticleRawExternalizationInput {
  articleTable: ArticleRawExternalizationTable;
  articleRowId: string;
  storageRef: string;
  contentHash: string;
  contentSize: number;
  externalizationContractVersion: string;
  actorId: string | null;
}

export interface AttachArticleRawExternalizationResult {
  articleRowId: string;
  idempotent: boolean;
}

export interface ArticleRawExternalizationRepository {
  listArticleRawExternalizationCandidates(
    input: ListArticleRawExternalizationCandidatesInput,
  ): Promise<ArticleRawExternalizationCandidate[]>;
  attachArticleRawExternalization(
    input: AttachArticleRawExternalizationInput,
  ): Promise<AttachArticleRawExternalizationResult>;
}

export interface ArticleRawExternalizationDependencies {
  repository: ArticleRawExternalizationRepository;
  store: ArtifactBlobStore;
}

export interface ArticleRawExternalizationInput {
  articleTable: ArticleRawExternalizationTable;
  sourceKey?: string | null;
  batchSize: number;
  afterArticleRowId?: string | null;
  actorId: string;
  execute: boolean;
  concurrency?: number;
}

export interface ArticleRawExternalizationPlan {
  candidate: ArticleRawExternalizationCandidate;
  document: string;
  bytes: Buffer;
  contentHash: string;
  contentSize: number;
}
export interface ArticleRawExternalizationOutcome {
  articleTable: ArticleRawExternalizationTable;
  articleRowId: string;
  sourceKey: string;
  status: "planned" | "externalized" | "idempotent";
  storageRef: string;
  contentHash: string;
  contentSize: number;
}

/**
 * CLI-safe projection: it exposes only status, row id, and size so no storage ref,
 * content hash, inline raw text, token, or URL is ever written to stdout.
 */
export interface ArticleRawExternalizationSafeOutcome {
  status: ArticleRawExternalizationOutcome["status"];
  articleRowId: string;
  contentSize: number;
}

export interface ArticleRawExternalizationBatchResult {
  scanned: number;
  externalized: number;
  idempotent: number;
  failed: { articleRowId: string; errorCode: string }[];
  outcomes: ArticleRawExternalizationOutcome[];
  lastArticleRowId: string | null;
}

export type ArticleRawExternalizationMetadataClassification =
  | "pending"
  | "idempotent"
  | "metadata_conflict";

function externalizationErrorCode(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z][a-z0-9._-]{0,159}$/.test(value) ? value : "article_raw_externalization.failed";
}

export function toSafeArticleRawExternalizationOutcome(
  outcome: ArticleRawExternalizationOutcome,
): ArticleRawExternalizationSafeOutcome {
  return {
    status: outcome.status,
    articleRowId: outcome.articleRowId,
    contentSize: outcome.contentSize,
  };
}

/**
 * Rebuild the exact article-raw Blob document from the inline text with the M6A
 * codec and fail closed before a single byte is uploaded on any shape problem.
 */
export function planArticleRawExternalization(
  candidate: ArticleRawExternalizationCandidate,
): ArticleRawExternalizationPlan {
  if (typeof candidate.rawText !== "string") {
    throw new Error("article_raw_externalization.inline_payload_missing");
  }
  if (!/^[a-z][a-z0-9._-]{0,79}$/.test(candidate.sourceKey)) {
    throw new Error("article_raw_externalization.source_key_invalid");
  }
  const encoded = encodeArticleRawText(candidate.rawText);
  return {
    candidate,
    document: encoded.document,
    bytes: encoded.bytes,
    contentHash: encoded.sha256,
    contentSize: encoded.size,
  };
}

/**
 * Classify the row's five externalization metadata columns against the expected
 * content-addressed ref/hash/size and contract before any upload:
 *
 *   all five null                                  -> pending
 *   all five present and exact, nonempty timestamp -> idempotent
 *   any partial or conflicting value               -> metadata_conflict
 */
export function classifyArticleRawExternalization(
  candidate: ArticleRawExternalizationCandidate,
  plan: ArticleRawExternalizationPlan,
): ArticleRawExternalizationMetadataClassification {
  const metadata = [
    candidate.rawTextStorageRef,
    candidate.rawTextBlobHash,
    candidate.rawTextBlobSize,
    candidate.rawTextExternalizedAt,
    candidate.rawTextBlobContractVersion,
  ];
  const present = metadata.filter((value) => value !== null).length;
  if (present === 0) return "pending";
  if (present < metadata.length) return "metadata_conflict";
  const expectedRef = articleRawBlobStorageRef(candidate.sourceKey, plan.contentHash);
  const exact = candidate.rawTextStorageRef === expectedRef
    && candidate.rawTextBlobHash === plan.contentHash
    && candidate.rawTextBlobSize === plan.contentSize
    && typeof candidate.rawTextExternalizedAt === "string"
    && candidate.rawTextExternalizedAt.trim() !== ""
    && candidate.rawTextBlobContractVersion === ARTICLE_RAW_BLOB_CONTRACT_VERSION;
  return exact ? "idempotent" : "metadata_conflict";
}

/**
 * Upload the planned document through ArtifactBlobStore, then head/get verify size
 * and SHA-256 and decode the stored JSON string back before the repository attach
 * RPC is ever called, so the DB stays untouched on any Blob or decode failure. The
 * attach records the dedicated article raw blob contract version, not the generic
 * artifact contract version.
 */
export async function externalizeArticleRawPlan(
  plan: ArticleRawExternalizationPlan,
  dependencies: ArticleRawExternalizationDependencies,
  actorId: string,
): Promise<ArticleRawExternalizationOutcome> {
  const { candidate } = plan;
  const uploaded = await dependencies.store.put({
    kind: "article_raw",
    sourceKey: candidate.sourceKey,
    bytes: plan.bytes,
  });
  if (uploaded.sha256 !== plan.contentHash || uploaded.size !== plan.contentSize) {
    throw new Error("article_raw_externalization.upload_verification_failed");
  }
  const head = await dependencies.store.head(uploaded.storageRef);
  if (head.size !== plan.contentSize) {
    throw new Error("article_raw_externalization.head_verification_failed");
  }
  const stored = await dependencies.store.get(uploaded.storageRef);
  if (stored.byteLength !== plan.contentSize || sha256Hex(stored) !== plan.contentHash) {
    throw new Error("article_raw_externalization.get_verification_failed");
  }
  if (decodeArticleRawText(stored) !== candidate.rawText) {
    throw new Error("article_raw_externalization.text_mismatch");
  }
  const attached = await dependencies.repository.attachArticleRawExternalization({
    articleTable: candidate.articleTable,
    articleRowId: candidate.articleRowId,
    storageRef: uploaded.storageRef,
    contentHash: plan.contentHash,
    contentSize: plan.contentSize,
    externalizationContractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
    actorId,
  });
  return {
    articleTable: candidate.articleTable,
    articleRowId: candidate.articleRowId,
    sourceKey: candidate.sourceKey,
    status: attached.idempotent ? "idempotent" : "externalized",
    storageRef: uploaded.storageRef,
    contentHash: plan.contentHash,
    contentSize: plan.contentSize,
  };
}

/** One bounded batch. In dry-run mode it only plans and never uploads or mutates. */
export async function runArticleRawExternalizationBatch(
  input: ArticleRawExternalizationInput,
  dependencies: ArticleRawExternalizationDependencies,
): Promise<ArticleRawExternalizationBatchResult> {
  const candidates = await dependencies.repository.listArticleRawExternalizationCandidates({
    articleTable: input.articleTable,
    sourceKey: input.sourceKey ?? null,
    limit: input.batchSize,
    afterArticleRowId: input.afterArticleRowId ?? null,
  });
  const outcomes: ArticleRawExternalizationOutcome[] = [];
  const failed: { articleRowId: string; errorCode: string }[] = [];
  const concurrency = Math.max(1, Math.min(input.concurrency ?? 1, 8));
  const settled = new Array<
    | { ok: true; outcome: ArticleRawExternalizationOutcome }
    | { ok: false; articleRowId: string; errorCode: string }
  >(candidates.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= candidates.length) return;
      const candidate = candidates[index];
      try {
        const plan = planArticleRawExternalization(candidate);
        const classification = classifyArticleRawExternalization(candidate, plan);
        if (classification === "metadata_conflict") {
          throw new Error("article_raw_externalization.metadata_conflict");
        }
        const storageRef = articleRawBlobStorageRef(candidate.sourceKey, plan.contentHash);
        if (classification === "idempotent") {
          settled[index] = {
            ok: true,
            outcome: {
              articleTable: candidate.articleTable,
              articleRowId: candidate.articleRowId,
              sourceKey: candidate.sourceKey,
              status: "idempotent",
              storageRef,
              contentHash: plan.contentHash,
              contentSize: plan.contentSize,
            },
          };
          continue;
        }
        if (!input.execute) {
          settled[index] = {
            ok: true,
            outcome: {
              articleTable: candidate.articleTable,
              articleRowId: candidate.articleRowId,
              sourceKey: candidate.sourceKey,
              status: "planned",
              storageRef,
              contentHash: plan.contentHash,
              contentSize: plan.contentSize,
            },
          };
          continue;
        }
        settled[index] = {
          ok: true,
          outcome: await externalizeArticleRawPlan(plan, dependencies, input.actorId),
        };
      } catch (error) {
        settled[index] = {
          ok: false,
          articleRowId: candidate.articleRowId,
          errorCode: externalizationErrorCode(error),
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(candidates.length, 1)) }, () => worker()),
  );

  let externalized = 0;
  let idempotent = 0;
  for (const result of settled) {
    if (!result) continue;
    if (!result.ok) {
      failed.push({ articleRowId: result.articleRowId, errorCode: result.errorCode });
      continue;
    }
    const outcome = result.outcome;
    outcomes.push(outcome);
    if (outcome.status === "idempotent") idempotent += 1;
    else if (outcome.status === "externalized") externalized += 1;
  }
  return {
    scanned: candidates.length,
    externalized,
    idempotent,
    failed,
    outcomes,
    lastArticleRowId: candidates.length > 0 ? candidates[candidates.length - 1].articleRowId : null,
  };
}
