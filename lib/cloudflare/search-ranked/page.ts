import type { RankedSearchEntry, RankedSearchPagePayload, RankedSearchPageRow, RankedSearchRetrievalMode } from "./types";

/**
 * Pure page assembly shared by every ranked-search branch.
 *
 * `rows` is the raw `limit + 1` result window. The extra row is trimmed and only
 * used to compute `hasMore`, exactly like the RPC. When a separate exact COUNT was
 * executed, `exactTotal` is the true total and `totalIsExact` is true. Otherwise
 * the RPC lower-bound semantics apply:
 *
 *   total = offset + returned + (hasMore ? 1 : 0)
 *
 * No estimate is ever fabricated for `planned`/`estimated`/`none`.
 */
export function assembleRankedSearchPage(params: {
  retrievalMode: RankedSearchRetrievalMode;
  rows: readonly RankedSearchPageRow[];
  limit: number;
  offset: number;
  exactTotal: number | null;
}): RankedSearchPagePayload {
  const pageCount = params.rows.length;
  const hasMore = pageCount > params.limit;
  const entries: RankedSearchEntry[] = params.rows.slice(0, params.limit).map((row) => {
    const entry: RankedSearchEntry = { id: row.id };
    if (row.score !== undefined) entry.score = row.score;
    if (row.lexicalRank !== undefined) entry.lexicalRank = row.lexicalRank;
    if (row.semanticRank !== undefined) entry.semanticRank = row.semanticRank;
    if (row.semanticSimilarity !== undefined) entry.semanticSimilarity = row.semanticSimilarity;
    return entry;
  });
  const totalIsExact = params.exactTotal !== null;
  const total = totalIsExact ? (params.exactTotal as number) : params.offset + entries.length + (hasMore ? 1 : 0);
  return {
    entries,
    retrievalMode: params.retrievalMode,
    total,
    hasMore,
    totalIsExact,
  };
}
