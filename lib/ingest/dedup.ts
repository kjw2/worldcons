import type { NormalizedArticle } from "@/lib/sources/types";
import { createHash } from "@/lib/utils/hash";

export function dedupKeysForArticle(article: NormalizedArticle) {
  const titleDate = [article.originalTitle, article.originalPublishedAt].filter(Boolean).join("|");
  const textPrefix = article.cleanedText?.slice(0, 1500) ?? "";

  return {
    canonicalUrl: article.canonicalUrl,
    titleDateHash: titleDate ? createHash(titleDate, 16) : null,
    textPrefixHash: textPrefix ? createHash(textPrefix, 16) : null,
  };
}

export function uniqueDiscoveredItems<T extends { canonicalUrl: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.canonicalUrl)) {
      return false;
    }

    seen.add(item.canonicalUrl);
    return true;
  });
}
