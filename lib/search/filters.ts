import type { ArticleListFilters } from "@/lib/db/types";
import { getRangeStart, normalizeRange } from "@/lib/utils/dates";

export function buildDateRangeFilter(rangeValue?: string | null) {
  const range = normalizeRange(rangeValue);
  const start = getRangeStart(range);
  return start ? { range, startIso: start.toISOString() } : { range, startIso: null };
}

export function describeFilters(filters: ArticleListFilters) {
  return {
    q: filters.q,
    range: filters.range ?? "latest",
    source: filters.source,
    jurisdiction: filters.jurisdiction,
    type: filters.type,
    tag: filters.tag,
    language: filters.language,
  };
}
