import { cleanText } from "@/lib/ingest/extract-text";
import type { NormalizedArticle, RawArticle, SourceAdapter } from "@/lib/sources/types";
import { toIsoDate } from "@/lib/utils/dates";

export function normalizeRawArticle(raw: RawArticle, adapter: SourceAdapter): NormalizedArticle {
  const cleanedText = cleanText(raw.text);

  return {
    sourceKey: adapter.sourceKey,
    jurisdiction: adapter.jurisdiction,
    institutionName: adapter.displayName,
    contentType: raw.contentType,
    originalUrl: raw.url,
    canonicalUrl: raw.canonicalUrl,
    originalLanguage: adapter.defaultLanguage,
    originalTitle: raw.title,
    originalPublishedAt: toIsoDate(raw.publishedAt),
    rawText: raw.text,
    cleanedText,
    metadata: raw.metadata,
  };
}
