import {
  ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  ARTICLE_RAW_BLOB_MAX_BYTES,
  articleRawBlobStorageRef,
  decodeArticleRawText,
} from "@/lib/article-raw/codec";
import { articleRawBlobReadReady } from "@/lib/article-raw/flags";
import {
  isArtifactStorageRef,
  sha256Hex,
  type ArtifactBlobStore,
} from "@/lib/storage/blob";

/**
 * Article raw-text dual read (M6A core).
 *
 * Reads are inline-first: when `raw_text` is still present it is returned as-is
 * and Blob is never touched, even if externalization metadata also exists. Only a
 * row with no inline text falls back to the private Blob object, and that path is
 * gated by the read flag and validated end to end:
 *
 *   inline present            -> return inline, no Blob call
 *   no ref, no metadata       -> unavailable
 *   no ref, dangling metadata -> metadata_inconsistent
 *   read flag not ready       -> read_disabled (before any Blob access)
 *   contract missing/mismatch -> metadata_inconsistent / contract_unsupported
 *   ref/hash/size inconsistent -> metadata_inconsistent / invalid_ref
 *   head/get size or hash off -> integrity_mismatch
 *   bytes are not a JSON str  -> invalid_document
 *
 * Every failure is an explicit thrown error code; the reader never returns a
 * partial or silently-truncated value.
 */

export interface ArticleRawBlobReadRow {
  sourceKey: string;
  rawText: string | null;
  rawTextStorageRef: string | null;
  rawTextBlobHash: string | null;
  rawTextBlobSize: number | null;
  rawTextExternalizedAt: string | null;
  rawTextBlobContractVersion: string | null;
}

export interface ArticleRawReaderDependencies {
  store: ArtifactBlobStore;
  environment?: Record<string, string | undefined>;
}

export interface ArticleRawTextResolution {
  rawText: string;
  source: "inline" | "blob";
  storageRef: string | null;
  sha256: string | null;
  size: number;
}

function hasDanglingExternalizationMetadata(row: ArticleRawBlobReadRow) {
  return row.rawTextBlobHash !== null
    || row.rawTextBlobSize !== null
    || row.rawTextExternalizedAt !== null
    || row.rawTextBlobContractVersion !== null;
}

export async function readArticleRawText(
  row: ArticleRawBlobReadRow,
  dependencies: ArticleRawReaderDependencies,
): Promise<ArticleRawTextResolution> {
  if (typeof row.rawText === "string") {
    return { rawText: row.rawText, source: "inline", storageRef: null, sha256: null, size: 0 };
  }

  const storageRef = row.rawTextStorageRef?.trim() ?? "";
  if (!storageRef) {
    if (hasDanglingExternalizationMetadata(row)) {
      throw new Error("article_raw_blob.metadata_inconsistent");
    }
    throw new Error("article_raw_blob.unavailable");
  }

  const environment = dependencies.environment ?? process.env;
  if (!articleRawBlobReadReady(environment)) throw new Error("article_raw_blob.read_disabled");

  const expectedHash = row.rawTextBlobHash;
  const expectedSize = row.rawTextBlobSize;
  const contractVersion = row.rawTextBlobContractVersion;

  if (contractVersion === null || expectedHash === null || expectedSize === null || row.rawTextExternalizedAt === null) {
    throw new Error("article_raw_blob.metadata_inconsistent");
  }
  if (contractVersion !== ARTICLE_RAW_BLOB_CONTRACT_VERSION) {
    throw new Error("article_raw_blob.contract_unsupported");
  }
  if (!isArtifactStorageRef(storageRef)) throw new Error("article_raw_blob.invalid_ref");
  if (expectedSize < 0 || expectedSize > ARTICLE_RAW_BLOB_MAX_BYTES) {
    throw new Error("article_raw_blob.metadata_inconsistent");
  }

  let expectedRef: string;
  try {
    expectedRef = articleRawBlobStorageRef(row.sourceKey, expectedHash);
  } catch {
    throw new Error("article_raw_blob.invalid_ref");
  }
  if (expectedRef !== storageRef) throw new Error("article_raw_blob.metadata_inconsistent");

  let headSize: number;
  try {
    headSize = (await dependencies.store.head(storageRef)).size;
  } catch {
    throw new Error("article_raw_blob.read_failed");
  }
  if (headSize !== expectedSize) throw new Error("article_raw_blob.integrity_mismatch");

  let bytes: Buffer;
  try {
    bytes = await dependencies.store.get(storageRef);
  } catch {
    throw new Error("article_raw_blob.read_failed");
  }
  if (bytes.byteLength !== expectedSize) throw new Error("article_raw_blob.integrity_mismatch");
  if (sha256Hex(bytes) !== expectedHash) throw new Error("article_raw_blob.integrity_mismatch");

  const rawText = decodeArticleRawText(bytes);
  return { rawText, source: "blob", storageRef, sha256: expectedHash, size: expectedSize };
}
