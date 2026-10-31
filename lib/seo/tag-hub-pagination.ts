import type { Metadata } from "next";
import type { TagSummary } from "@/lib/db/types";

export const TAG_HUB_PAGE_SIZE = 96;
const MAX_PAGE_NUMBER = 10_000;

export function parseTagHubPage(value?: string | string[]): number | null {
  if (value === undefined) return 1;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page <= MAX_PAGE_NUMBER ? page : null;
}

export function tagHubPageHref(page: number) {
  return page === 1 ? "/tags" : `/tags?page=${page}`;
}

/** Stable count order prevents ties moving randomly across page boundaries. */
export function paginateTagHub(tags: readonly TagSummary[], page: number) {
  const total = tags.length;
  const totalPages = Math.max(1, Math.ceil(total / TAG_HUB_PAGE_SIZE));
  if (!Number.isInteger(page) || page < 1 || page > totalPages) return null;
  const ordered = [...tags].sort(
    (a, b) => (b.articleCount ?? 0) - (a.articleCount ?? 0) || a.slug.localeCompare(b.slug, "en"),
  );
  return {
    page,
    total,
    totalPages,
    pageSize: TAG_HUB_PAGE_SIZE,
    tags: ordered.slice((page - 1) * TAG_HUB_PAGE_SIZE, page * TAG_HUB_PAGE_SIZE),
  };
}

export function tagHubMetadata(page: number | null, baseUrl: string): Pick<Metadata, "alternates" | "robots"> {
  const canonicalPage = page === null ? 1 : page;
  return {
    alternates: { canonical: `${baseUrl.replace(/\/$/, "")}${tagHubPageHref(canonicalPage)}` },
    ...(page === null ? { robots: { index: false, follow: true } } : {}),
  };
}
