import type { Metadata } from "next";
import type { TagSummary } from "@/lib/db/types";
import { tagMetadata } from "@/lib/seo/metadata";

export const TAG_DETAIL_PAGE_SIZE = 10;

export function parseTagDetailPage(value?: string | string[]): number | null {
  if (value === undefined) return 1;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page <= 10_000 ? page : null;
}

export function tagDetailPageHref(slug: string, page: number) {
  const path = `/tags/${encodeURIComponent(slug)}`;
  return page <= 1 ? path : `${path}?page=${page}`;
}

export function paginatedTagMetadata(tag: TagSummary, page: number): Metadata {
  const base = tagMetadata(tag);
  if (page <= 1) return base;
  const canonical = String(base.alternates?.canonical ?? "");
  return {
    ...base,
    alternates: { ...base.alternates, canonical: `${canonical}?page=${page}` },
    openGraph: { ...base.openGraph, url: `${canonical}?page=${page}` },
  };
}
