import {
  SEARCH_FTS_BM25_WEIGHTS,
  SearchFtsError,
  buildFtsExactTitleNeedle,
  compileSearchFtsQuery,
  searchFtsRangeThresholdIso,
} from "@/lib/cloudflare/search-fts";
import { buildExactTagNeedle } from "@/lib/cloudflare/search-projection";
import { RANKED_SEARCH_SEMANTIC_DEFERRED_MESSAGE, rankedError } from "./errors";
import { primaryCaseReference } from "./reference";
import {
  RANKED_SEARCH_DOCUMENT_TABLE,
  RANKED_SEARCH_FTS_TABLE,
  type RankedSearchParam,
  type RankedSearchQueryPlan,
  type RankedSearchResolvedRequest,
  type RankedSearchStatement,
} from "./types";

/**
 * Parameterized D1 query builders for the M7.3 ranked-search page branches.
 *
 * The SQL text contains ONLY authored identifiers and fixed syntax. The FTS5
 * MATCH expression, every filter value, the exact-tag needle, the UTC range
 * threshold, the exact-title needle, limit and offset are all bound `?`
 * parameters. No user text can reach the statement.
 *
 * Ordering and semantics mirror
 * `worldcons_ranked_search_page_v1` for the branches this slice supports:
 * - exact-case: `source_key = ?` + `case_key` as an exact `case_numbers` line
 *   token, ordered by published DESC NULLS LAST then id ASC;
 * - latest (empty query): same filters/order without the exact-case predicate;
 * - fulltext: FTS5 MATCH with exact-title-first, then `-bm25` DESC, then the same
 *   date/id tie-breaks. `score` is `-bm25(...)` so a larger score is better.
 */

const DOC = RANKED_SEARCH_DOCUMENT_TABLE;
const FTS = RANKED_SEARCH_FTS_TABLE;
const WEIGHTS = SEARCH_FTS_BM25_WEIGHTS;

const BM25_CALL = `-1.0 * bm25(${FTS}, ${WEIGHTS.article_id}, ${WEIGHTS.title}, ${WEIGHTS.case_numbers}, ${WEIGHTS.search_text}, ${WEIGHTS.tags_text})`;

const DATE_ORDER = [`(${DOC}.original_published_at is null) asc`, `${DOC}.original_published_at desc`, `${DOC}.article_id asc`];

interface FilterFragment {
  clauses: string[];
  params: RankedSearchParam[];
}

function documentFilter(resolved: RankedSearchResolvedRequest): FilterFragment {
  const clauses: string[] = [];
  const params: RankedSearchParam[] = [];
  if (resolved.source !== null) {
    clauses.push(`${DOC}.source_key = ?`);
    params.push(resolved.source);
  }
  if (resolved.jurisdiction !== null) {
    clauses.push(`${DOC}.jurisdiction = ?`);
    params.push(resolved.jurisdiction);
  }
  if (resolved.contentType !== null) {
    clauses.push(`${DOC}.content_type = ?`);
    params.push(resolved.contentType);
  }
  if (resolved.language !== null) {
    clauses.push(`${DOC}.language = ?`);
    params.push(resolved.language);
  }
  if (resolved.tag !== null) {
    const needle = buildExactTagNeedle(resolved.tag);
    if (needle === null) throw rankedError("invalid_filter", "tag must be non-empty when provided");
    clauses.push(`instr(${DOC}.tags_text, ?) > 0`);
    params.push(needle);
  }
  const threshold = searchFtsRangeThresholdIso(resolved.range, resolved.referenceNow);
  if (threshold !== null) {
    clauses.push(`${DOC}.original_published_at >= ?`);
    params.push(threshold);
  }
  return { clauses, params };
}

function exactCaseFilter(resolved: RankedSearchResolvedRequest, sourceKey: string, caseKey: string): FilterFragment {
  const filter = documentFilter(resolved);
  return {
    clauses: [
      `${DOC}.source_key = ?`,
      `instr(char(10) || ${DOC}.case_numbers || char(10), char(10) || ? || char(10)) > 0`,
      ...filter.clauses,
    ],
    params: [sourceKey, caseKey, ...filter.params],
  };
}

function whereLine(clauses: readonly string[]): string[] {
  return clauses.length > 0 ? [`where ${clauses.join(" and ")}`] : [];
}

function exactOrLatestPageQuery(filter: FilterFragment, resolved: RankedSearchResolvedRequest): RankedSearchStatement {
  const sql = [
    `select ${DOC}.article_id as article_id`,
    `from ${DOC}`,
    ...whereLine(filter.clauses),
    `order by ${DATE_ORDER.join(", ")}`,
    "limit ? offset ?",
  ].join("\n");
  return { sql, params: [...filter.params, resolved.limit + 1, resolved.offset] };
}

function exactOrLatestCountQuery(filter: FilterFragment): RankedSearchStatement {
  const sql = [`select count(*) as total`, `from ${DOC}`, ...whereLine(filter.clauses)].join("\n");
  return { sql, params: filter.params };
}

function fulltextFilter(resolved: RankedSearchResolvedRequest): FilterFragment & { matchExpression: string; exactQueryText: string } {
  let compiled;
  try {
    compiled = compileSearchFtsQuery(resolved.queryText);
  } catch (error) {
    if (error instanceof SearchFtsError) {
      throw rankedError("invalid_query", `${error.code}: ${error.message}`);
    }
    throw error;
  }
  const filter = documentFilter(resolved);
  return {
    matchExpression: compiled.matchExpression,
    exactQueryText: compiled.exactQueryText,
    clauses: [`${FTS} match ?`, ...filter.clauses],
    params: [compiled.matchExpression, ...filter.params],
  };
}

function fulltextPageQuery(filter: FilterFragment & { exactQueryText: string }, resolved: RankedSearchResolvedRequest): RankedSearchStatement {
  const sql = [
    `select ${DOC}.article_id as article_id, ${BM25_CALL} as score`,
    `from ${FTS}`,
    `join ${DOC} on ${DOC}.article_id = ${FTS}.article_id`,
    `where ${filter.clauses.join(" and ")}`,
    `order by (instr(${FTS}.title, ?) > 0) desc, score desc, ${DATE_ORDER.join(", ")}`,
    "limit ? offset ?",
  ].join("\n");
  return {
    sql,
    params: [...filter.params, buildFtsExactTitleNeedle(filter.exactQueryText), resolved.limit + 1, resolved.offset],
  };
}

function fulltextCountQuery(filter: FilterFragment): RankedSearchStatement {
  const sql = [
    `select count(*) as total`,
    `from ${FTS}`,
    `join ${DOC} on ${DOC}.article_id = ${FTS}.article_id`,
    `where ${filter.clauses.join(" and ")}`,
  ].join("\n");
  return { sql, params: filter.params };
}

function buildCount(resolved: RankedSearchResolvedRequest, build: () => RankedSearchStatement): RankedSearchStatement | null {
  return resolved.count === "exact" ? build() : null;
}

/**
 * Resolves the branch for a validated request and builds its parameterized page
 * (and, for `count = exact`, COUNT) statement. Throws `semantic_deferred` for a
 * non-empty, non-exact `semantic`/`hybrid` request: M7.3 never approximates
 * semantic/hybrid with lexical search.
 */
export function buildRankedSearchQueryPlan(resolved: RankedSearchResolvedRequest): RankedSearchQueryPlan {
  const exact = primaryCaseReference(resolved.queryText);

  if (exact !== null) {
    if (resolved.source !== null && resolved.source !== exact.sourceKey) {
      return { retrievalMode: "exact-case", sourceConflict: true, exactCase: exact, page: null, count: null };
    }
    const buildFilter = () => exactCaseFilter(resolved, exact.sourceKey, exact.caseKey);
    return {
      retrievalMode: "exact-case",
      sourceConflict: false,
      exactCase: exact,
      page: exactOrLatestPageQuery(buildFilter(), resolved),
      count: buildCount(resolved, () => exactOrLatestCountQuery(buildFilter())),
    };
  }

  if (resolved.queryText === "") {
    const buildFilter = () => documentFilter(resolved);
    return {
      retrievalMode: "latest",
      sourceConflict: false,
      exactCase: null,
      page: exactOrLatestPageQuery(buildFilter(), resolved),
      count: buildCount(resolved, () => exactOrLatestCountQuery(buildFilter())),
    };
  }

  if (resolved.mode === "fulltext") {
    const built = fulltextFilter(resolved);
    return {
      retrievalMode: "fulltext",
      sourceConflict: false,
      exactCase: null,
      page: fulltextPageQuery(built, resolved),
      count: buildCount(resolved, () => fulltextCountQuery(built)),
    };
  }

  throw rankedError("semantic_deferred", RANKED_SEARCH_SEMANTIC_DEFERRED_MESSAGE);
}
