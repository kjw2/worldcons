import type { ArticleListItem } from "@/lib/db/types";
import { formatDisplayDate } from "@/lib/utils/dates";

export function articleDateLabel(sourceKey?: string | null) {
  return sourceKey === "es-tribunal-constitucional" ? "선고일/결정일" : "게시일";
}

export function formattedArticleDate(article: Pick<ArticleListItem, "sourceKey" | "originalPublishedAt">, options: { includeLabel?: boolean } = {}) {
  const date = formatDisplayDate(article.originalPublishedAt);
  return options.includeLabel ? `${articleDateLabel(article.sourceKey)} ${date}` : date;
}

export function spainBoeMetadata(sourceMetadata?: Record<string, unknown> | null) {
  if (!sourceMetadata || sourceMetadata.boeUsedForFiltering !== false) return null;
  const boePublishedAt = typeof sourceMetadata.boePublishedAt === "string" ? sourceMetadata.boePublishedAt : null;
  const referenceBoe = typeof sourceMetadata.referenceBoe === "string" ? sourceMetadata.referenceBoe : null;
  const boeNumber = typeof sourceMetadata.boeNumber === "string" ? sourceMetadata.boeNumber : null;
  const boeUrl = typeof sourceMetadata.boeUrl === "string" ? sourceMetadata.boeUrl : null;
  if (!boePublishedAt && !referenceBoe && !boeNumber && !boeUrl) return null;
  return { boePublishedAt, referenceBoe, boeNumber, boeUrl };
}

