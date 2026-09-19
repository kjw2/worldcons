import {
  buildArtifactStorageRef,
  sha256Hex,
  type ArtifactBlobKind,
} from "@/lib/storage/blob";

/**
 * Article raw-text Blob codec (M6A).
 *
 * The private Blob object for an article's `raw_text` is a single JSON string
 * document: `JSON.stringify(rawText)` encoded as UTF-8. The document is
 * deterministic, so the SHA-256 over its UTF-8 bytes is stable and is the same
 * value that appears in the storage ref and in `raw_text_blob_hash`.
 *
 * The DB keeps `raw_text` unchanged and nullable; this codec only defines how the
 * inline value is encoded to, and decoded from, the externalized object. Both the
 * encode and decode directions validate the 4 MiB bound and fail closed.
 */

export const ARTICLE_RAW_BLOB_CONTRACT_VERSION = "worldcons-article-raw-blob-v1";
export const ARTICLE_RAW_BLOB_KIND: ArtifactBlobKind = "article_raw";
export const ARTICLE_RAW_BLOB_MAX_BYTES = 4 * 1024 * 1024;

export interface ArticleRawBlobEncoded {
  document: string;
  bytes: Buffer;
  sha256: string;
  size: number;
}

export function encodeArticleRawText(rawText: string): ArticleRawBlobEncoded {
  if (typeof rawText !== "string") throw new Error("article_raw_blob.invalid_raw_text");
  const document = JSON.stringify(rawText);
  const bytes = Buffer.from(document, "utf8");
  if (bytes.byteLength > ARTICLE_RAW_BLOB_MAX_BYTES) {
    throw new Error("article_raw_blob.payload_too_large");
  }
  return { document, bytes, sha256: sha256Hex(bytes), size: bytes.byteLength };
}

export function decodeArticleRawText(bytes: Uint8Array | Buffer): string {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.byteLength > ARTICLE_RAW_BLOB_MAX_BYTES) {
    throw new Error("article_raw_blob.payload_too_large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("article_raw_blob.invalid_document");
  }
  if (typeof parsed !== "string") throw new Error("article_raw_blob.invalid_document");
  return parsed;
}

export function articleRawBlobStorageRef(sourceKey: string, sha256: string): string {
  return buildArtifactStorageRef(ARTICLE_RAW_BLOB_KIND, sourceKey, sha256);
}
