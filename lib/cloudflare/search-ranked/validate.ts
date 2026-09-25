import { rankedError } from "./errors";
import {
  RANKED_SEARCH_COUNTS,
  RANKED_SEARCH_MAX_LIMIT,
  RANKED_SEARCH_MAX_OFFSET,
  RANKED_SEARCH_MAX_QUERY_LENGTH,
  RANKED_SEARCH_MIN_LIMIT,
  RANKED_SEARCH_MIN_OFFSET,
  RANKED_SEARCH_MODES,
  RANKED_SEARCH_RANGES,
  type RankedSearchCount,
  type RankedSearchMode,
  type RankedSearchPageInput,
  type RankedSearchRange,
  type RankedSearchResolvedRequest,
} from "./types";

/** RPC argument defaults (`worldcons_ranked_search_page_v1`). */
export const RANKED_SEARCH_DEFAULT_LIMIT = 20;
export const RANKED_SEARCH_DEFAULT_MODE: RankedSearchMode = "hybrid";
export const RANKED_SEARCH_DEFAULT_RANGE: RankedSearchRange = "latest";
export const RANKED_SEARCH_DEFAULT_COUNT: RankedSearchCount = "none";

function resolveQuery(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw rankedError("invalid_query", "query must be a string");
  const trimmed = value.trim();
  if (trimmed.length > RANKED_SEARCH_MAX_QUERY_LENGTH) {
    throw rankedError("invalid_query", `query must be at most ${RANKED_SEARCH_MAX_QUERY_LENGTH} characters`);
  }
  return trimmed;
}

function resolveEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T, code: "invalid_mode" | "invalid_count"): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw rankedError(code, `value must be one of ${allowed.join(", ")}`);
  const normalized = value.trim().toLowerCase() as T;
  if (!allowed.includes(normalized)) throw rankedError(code, `value must be one of ${allowed.join(", ")}`);
  return normalized;
}

/**
 * Resolves `p_range` exactly like the RPC (and M7.2 `resolveRange`): the value
 * is compared verbatim with no trim/case-folding, and a missing value defaults
 * to `latest`. The RPC lowercases/trims `p_mode` and `p_count` but NOT
 * `p_range`, so folding it here would accept inputs the authority rejects.
 */
function resolveRange(value: unknown): RankedSearchRange {
  if (value === undefined || value === null) return RANKED_SEARCH_DEFAULT_RANGE;
  if (typeof value !== "string" || !RANKED_SEARCH_RANGES.includes(value as RankedSearchRange)) {
    throw rankedError("invalid_range", `range must be one of ${RANKED_SEARCH_RANGES.join(", ")}`);
  }
  return value as RankedSearchRange;
}

function resolveLimit(value: unknown): number {
  if (value === undefined || value === null) return RANKED_SEARCH_DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw rankedError("invalid_limit", `limit must be an integer between ${RANKED_SEARCH_MIN_LIMIT} and ${RANKED_SEARCH_MAX_LIMIT}`);
  }
  if (value < RANKED_SEARCH_MIN_LIMIT || value > RANKED_SEARCH_MAX_LIMIT) {
    throw rankedError("invalid_limit", `limit must be between ${RANKED_SEARCH_MIN_LIMIT} and ${RANKED_SEARCH_MAX_LIMIT}`);
  }
  return value;
}

function resolveOffset(value: unknown): number {
  if (value === undefined || value === null) return RANKED_SEARCH_MIN_OFFSET;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw rankedError("invalid_offset", `offset must be an integer between ${RANKED_SEARCH_MIN_OFFSET} and ${RANKED_SEARCH_MAX_OFFSET}`);
  }
  if (value < RANKED_SEARCH_MIN_OFFSET || value > RANKED_SEARCH_MAX_OFFSET) {
    throw rankedError("invalid_offset", `offset must be between ${RANKED_SEARCH_MIN_OFFSET} and ${RANKED_SEARCH_MAX_OFFSET}`);
  }
  return value;
}

function resolveFilter(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw rankedError("invalid_filter", `${name} must be a string when provided`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw rankedError("invalid_filter", `${name} must be non-empty when provided`);
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
  throw rankedError("invalid_clock", "referenceNow must be a valid Date, epoch milliseconds or ISO-8601 string");
}

/** Validates and normalizes an input, failing closed with stable codes. */
export function resolveRankedSearchInput(input: RankedSearchPageInput): RankedSearchResolvedRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw rankedError("invalid_query", "input must be an object");
  }
  return {
    queryText: resolveQuery(input.query),
    mode: resolveEnum(input.mode, RANKED_SEARCH_MODES, RANKED_SEARCH_DEFAULT_MODE, "invalid_mode"),
    limit: resolveLimit(input.limit),
    offset: resolveOffset(input.offset),
    source: resolveFilter(input.source, "source"),
    jurisdiction: resolveFilter(input.jurisdiction, "jurisdiction"),
    contentType: resolveFilter(input.contentType, "contentType"),
    language: resolveFilter(input.language, "language"),
    tag: resolveFilter(input.tag, "tag"),
    range: resolveRange(input.range),
    count: resolveEnum(input.count, RANKED_SEARCH_COUNTS, RANKED_SEARCH_DEFAULT_COUNT, "invalid_count"),
    hasEmbedding: input.embedding !== undefined && input.embedding !== null,
    referenceNow: resolveReferenceNow(input.referenceNow),
  };
}
