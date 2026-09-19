import { articleRawBlobReadReady } from "@/lib/article-raw/flags";
import { readArticleRawText, type ArticleRawTextResolution } from "@/lib/article-raw/reader";
import type { ArticleDetail } from "@/lib/db/types";
import type { ArtifactBlobStore } from "@/lib/storage/blob";

/**
 * M6A dual read for the article detail surface.
 *
 * Hydration is inline-first and detail-only: an article that already carries
 * inline `raw_text` is returned untouched, and an article without externalization
 * metadata is returned untouched, so neither case touches Blob storage. Only a
 * detail row with no inline text but complete Blob metadata is hydrated, and only
 * when the read flag is ready. Any read or integrity failure is swallowed into
 * "raw_text stays absent" so a public detail page never fails open on partial
 * content.
 */
export interface ArticleRawDetailReadDependencies {
  store: ArtifactBlobStore;
  environment?: Record<string, string | undefined>;
}

export async function hydrateArticleRawText(
  article: ArticleDetail,
  dependencies: ArticleRawDetailReadDependencies,
): Promise<ArticleDetail> {
  if (typeof article.rawText === "string") return article;
  const blob = article.rawTextBlob;
  if (!blob) return article;

  const environment = dependencies.environment ?? process.env;
  if (!articleRawBlobReadReady(environment)) return article;

  let resolution: ArticleRawTextResolution;
  try {
    resolution = await readArticleRawText(
      {
        sourceKey: article.sourceKey,
        rawText: article.rawText ?? null,
        rawTextStorageRef: blob.storageRef,
        rawTextBlobHash: blob.blobHash,
        rawTextBlobSize: blob.blobSize,
        rawTextExternalizedAt: blob.externalizedAt,
        rawTextBlobContractVersion: blob.contractVersion,
      },
      { store: dependencies.store, environment },
    );
  } catch {
    return article;
  }
  article.rawText = resolution.rawText;
  return article;
}
