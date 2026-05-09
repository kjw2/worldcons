import slugify from "slugify";
import type { NormalizedArticle } from "@/lib/sources/types";
import { createHash } from "@/lib/utils/hash";
import { formatSlugDate } from "@/lib/utils/dates";

export function slugifyText(input: string) {
  const normalized = slugify(input, {
    lower: true,
    strict: true,
    trim: true,
    replacement: "-",
    locale: "ko",
  });

  return normalized || createHash(input, 8);
}

export function generateArticleSlug(article: Pick<NormalizedArticle, "jurisdiction" | "sourceKey" | "originalPublishedAt" | "originalTitle" | "canonicalUrl"> & { koreanTitle?: string }) {
  const title = article.koreanTitle || article.originalTitle || article.canonicalUrl;
  const parts = [
    slugifyText(article.jurisdiction),
    slugifyText(article.sourceKey),
    formatSlugDate(article.originalPublishedAt),
    slugifyText(title).slice(0, 80),
    createHash(article.canonicalUrl, 6),
  ];

  return parts.filter(Boolean).join("-");
}

export function normalizeTagSlug(input: string) {
  return slugifyText(input.trim().replace(/#/g, ""));
}
