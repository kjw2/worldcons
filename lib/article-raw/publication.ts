import { ARTICLE_RAW_BLOB_CONTRACT_VERSION, encodeArticleRawText } from "@/lib/article-raw/codec";
import { sha256Hex, type ArtifactBlobStore } from "@/lib/storage/blob";

/**
 * M6A publication write path: encode an article's inline `raw_text` with the
 * article-raw codec, upload it to the private content-addressed Blob object, and
 * verify ref/hash/size end to end before the value is ever recorded in a version.
 *
 * Any codec, upload, head, get, size, or hash failure throws here. The caller
 * treats that as fail-closed and must not fall back to an inline capture: once
 * the Blob path is selected, a Blob-backed version is either fully verified or
 * nothing is recorded.
 */
export interface ArticleRawTextExternalization {
  storageRef: string;
  sha256: string;
  size: number;
  contractVersion: string;
}

export async function externalizeArticleRawText(
  store: ArtifactBlobStore,
  sourceKey: string,
  rawText: string,
): Promise<ArticleRawTextExternalization> {
  const encoded = encodeArticleRawText(rawText);
  const uploaded = await store.put({ kind: "article_raw", sourceKey, bytes: encoded.bytes });
  if (uploaded.sha256 !== encoded.sha256 || uploaded.size !== encoded.size) {
    throw new Error("article_raw_blob.upload_verification_failed");
  }
  const head = await store.head(uploaded.storageRef);
  if (head.size !== encoded.size) {
    throw new Error("article_raw_blob.head_verification_failed");
  }
  const stored = await store.get(uploaded.storageRef);
  if (stored.byteLength !== encoded.size || sha256Hex(stored) !== encoded.sha256) {
    throw new Error("article_raw_blob.get_verification_failed");
  }
  return {
    storageRef: uploaded.storageRef,
    sha256: encoded.sha256,
    size: encoded.size,
    contractVersion: ARTICLE_RAW_BLOB_CONTRACT_VERSION,
  };
}
