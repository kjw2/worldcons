import { ftsError } from "./errors";
import { compileSearchFtsQuery } from "./query-compiler";
import { buildFtsExactTitleNeedle } from "./title";
import {
  SEARCH_FTS_BM25_WEIGHTS,
  SEARCH_FTS_DOCUMENT_TABLE,
  SEARCH_FTS_MAX_LIMIT,
  SEARCH_FTS_MIN_LIMIT,
  SEARCH_FTS_RANGES,
  SEARCH_FTS_TABLE,
  type SearchFtsParam,
  type SearchFtsQueryInput,
  type SearchFtsRange,
  type SearchFtsStatement,
} from "./types";

/**
 * Parameterized D1 FTS5 query builder for the local
 * `public_fulltext_ranked_ids_v1` foundation.
 *
 * The SQL text contains ONLY authored identifiers and fixed syntax. The FTS5
 * MATCH expression, every filter value, the UTC range threshold, the exact-title
 * needle and the limit are all bound `?` parameters. No user text can reach the
 * statement.
 *
 * Ordering reproduces the RPC's documented priority:
 * exact-title DESC, relevance DESC, original_published_at DESC NULLS LAST,
 * article_id ASC. `relevance_score` is `-bm25(search_fts, ...)` so a larger
 * score is a better lexical match, but the exact-title boost is an ORDER-BY-only
 * signal and is deliberately NOT folded into the returned score.
 */

const DAY_MS = 86_400_000;

const WEIGHTS = SEARCH_FTS_BM25_WEIGHTS;

const BM25_CALL = `-1.0 * bm25(${SEARCH_FTS_TABLE}, ${WEIGHTS.article_id}, ${WEIGHTS.title}, ${WEIGHTS.case_numbers}, ${WEIGHTS.search_text}, ${WEIGHTS.tags_text})`;

/** UTC midnight (start of day) for an epoch instant. */
export function utcDayStartMs(epochMs: number): number {
  const date = new Date(epochMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Reproduces the RPC's `current_date` semantics conservatively at the UTC day
 * boundary: `today` is UTC midnight today, `week` is UTC midnight 7 days ago and
 * `month` is UTC midnight 30 days ago. `latest` has no threshold.
 */
export function searchFtsRangeThresholdIso(range: SearchFtsRange, epochMs: number): string | null {
  if (range === "latest") return null;
  const startOfToday = utcDayStartMs(epochMs);
  const daysBack = range === "today" ? 0 : range === "week" ? 7 : 30;
  return new Date(startOfToday - daysBack * DAY_MS).toISOString();
}

function resolveLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw ftsError("invalid_limit", `limit must be an integer between ${SEARCH_FTS_MIN_LIMIT} and ${SEARCH_FTS_MAX_LIMIT}`);
  }
  if (value < SEARCH_FTS_MIN_LIMIT || value > SEARCH_FTS_MAX_LIMIT) {
    throw ftsError("invalid_limit", `limit must be between ${SEARCH_FTS_MIN_LIMIT} and ${SEARCH_FTS_MAX_LIMIT}`);
  }
  return value;
}

function resolveRange(value: unknown): SearchFtsRange {
  if (value === undefined || value === null) return "latest";
  if (typeof value !== "string" || !SEARCH_FTS_RANGES.includes(value as SearchFtsRange)) {
    throw ftsError("invalid_range", `range must be one of ${SEARCH_FTS_RANGES.join(", ")}`);
  }
  return value as SearchFtsRange;
}

function resolveFilter(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw ftsError("invalid_filter", `${name} must be a string when provided`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw ftsError("invalid_filter", `${name} must be non-empty when provided`);
  return trimmed;
}

function resolveReferenceNow(value: unknown): number {
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isFinite(time)) return time;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  } else if (typeof value === "string") {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  throw ftsError("invalid_clock", "referenceNow must be a valid Date, epoch milliseconds or ISO-8601 string");
}

/** Builds the guarded, fully parameterized FTS5 statement. */
export function buildSearchFtsQuery(input: SearchFtsQueryInput): SearchFtsStatement {
  const compiled = compileSearchFtsQuery(input.query);
  const limit = resolveLimit(input.limit);
  const range = resolveRange(input.range);
  const source = resolveFilter(input.source, "source");
  const jurisdiction = resolveFilter(input.jurisdiction, "jurisdiction");
  const contentType = resolveFilter(input.contentType, "contentType");
  const language = resolveFilter(input.language, "language");
  const referenceNow = resolveReferenceNow(input.referenceNow);
  const rangeThreshold = searchFtsRangeThresholdIso(range, referenceNow);
  const exactNeedle = buildFtsExactTitleNeedle(compiled.exactQueryText);

  const params: SearchFtsParam[] = [compiled.matchExpression];
  const where: string[] = [`${SEARCH_FTS_TABLE} match ?`];
  if (source !== null) {
    where.push(`${SEARCH_FTS_DOCUMENT_TABLE}.source_key = ?`);
    params.push(source);
  }
  if (jurisdiction !== null) {
    where.push(`${SEARCH_FTS_DOCUMENT_TABLE}.jurisdiction = ?`);
    params.push(jurisdiction);
  }
  if (contentType !== null) {
    where.push(`${SEARCH_FTS_DOCUMENT_TABLE}.content_type = ?`);
    params.push(contentType);
  }
  if (language !== null) {
    where.push(`${SEARCH_FTS_DOCUMENT_TABLE}.language = ?`);
    params.push(language);
  }
  if (rangeThreshold !== null) {
    where.push(`${SEARCH_FTS_DOCUMENT_TABLE}.original_published_at >= ?`);
    params.push(rangeThreshold);
  }

  const orderBy = [
    `(instr(${SEARCH_FTS_TABLE}.title, ?) > 0) desc`,
    "relevance_score desc",
    `(${SEARCH_FTS_DOCUMENT_TABLE}.original_published_at is null) asc`,
    `${SEARCH_FTS_DOCUMENT_TABLE}.original_published_at desc`,
    `${SEARCH_FTS_DOCUMENT_TABLE}.article_id asc`,
  ];
  params.push(exactNeedle);
  params.push(limit);

  const sql = [
    `select ${SEARCH_FTS_DOCUMENT_TABLE}.article_id as article_id, ${BM25_CALL} as relevance_score`,
    `from ${SEARCH_FTS_TABLE}`,
    `join ${SEARCH_FTS_DOCUMENT_TABLE} on ${SEARCH_FTS_DOCUMENT_TABLE}.article_id = ${SEARCH_FTS_TABLE}.article_id`,
    `where ${where.join(" and ")}`,
    `order by ${orderBy.join(", ")}`,
    "limit ?",
  ].join("\n");

  return {
    sql,
    params,
    matchExpression: compiled.matchExpression,
    exactQueryText: compiled.exactQueryText,
    limit,
    range,
    rangeThreshold,
    hasNegation: compiled.negativeCount > 0,
  };
}
