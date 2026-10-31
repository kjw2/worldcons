import type { Metadata } from "next";
import { getSearchParam, type SearchParams } from "../utils/search-params";

const FILTER_KEYS = ["q", "source", "jurisdiction", "type", "tag", "language"] as const;

/**
 * Server-rendered archive pages contain different published cases.
 * Self-canonicalize unfiltered pagination so crawlers can follow the actual
 * HTML links to older cases. Filter and search combinations are useful for
 * browsing, but should not create duplicate search-index entries.
 */
export function publicListPaginationMetadata(
  params: SearchParams,
  baseUrl: string,
): Pick<Metadata, "alternates" | "robots"> {
  const rawPage = getSearchParam(params, "page");
  const requestedPage = rawPage === undefined ? 1 : Number(rawPage);
  const validPage = Number.isSafeInteger(requestedPage) && requestedPage >= 1 && requestedPage <= 10_000;
  const hasFilter = FILTER_KEYS.some((key) => Boolean(getSearchParam(params, key)?.trim()));
  const range = getSearchParam(params, "range")?.trim();
  const filtered = hasFilter || Boolean(range && range !== "latest");
  const canonical = `${baseUrl.replace(/\/$/, "")}/list${!filtered && validPage && requestedPage > 1 ? `?page=${requestedPage}` : ""}`;

  return {
    alternates: { canonical },
    ...(filtered || !validPage ? { robots: { index: false, follow: true } } : {}),
  };
}
