import type { ArticleContentType } from "@/lib/db/types";
import { ARTICLE_CONTENT_TYPES } from "@/lib/db/types";
import { normalizeRange } from "@/lib/utils/dates";

export type SearchParams = Record<string, string | string[] | undefined>;

export async function resolveSearchParams(searchParams?: Promise<SearchParams> | SearchParams) {
  if (!searchParams) return {};
  return Promise.resolve(searchParams);
}

export function getSearchParam(params: SearchParams, key: string) {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

export function getNumberSearchParam(params: SearchParams, key: string) {
  const value = getSearchParam(params, key);
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function articleFiltersFromSearchParams(params: SearchParams) {
  const type = getSearchParam(params, "type");

  return {
    q: getSearchParam(params, "q"),
    range: normalizeRange(getSearchParam(params, "range")),
    source: getSearchParam(params, "source"),
    jurisdiction: getSearchParam(params, "jurisdiction"),
    type: ARTICLE_CONTENT_TYPES.includes(type as ArticleContentType) ? (type as ArticleContentType) : undefined,
    tag: getSearchParam(params, "tag"),
    language: getSearchParam(params, "language"),
    page: getNumberSearchParam(params, "page"),
    pageSize: getNumberSearchParam(params, "pageSize"),
  };
}
