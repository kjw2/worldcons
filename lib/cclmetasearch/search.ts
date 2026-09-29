import type { CclMetasearchSearchInput, CclMetasearchSearchPage } from "@/lib/cclmetasearch/contract";
import { mapCclMetasearchRow } from "@/lib/cclmetasearch/mapper";
import { getRuntimeD1Binding, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { runD1RuntimeRead } from "@/lib/cloudflare/d1/runtime-read";
import { d1Schema } from "@/lib/cloudflare/d1/schema";
import type { D1TableDefinition } from "@/lib/cloudflare/d1/types";
import {
  SEARCH_FTS_BM25_WEIGHTS,
  SEARCH_FTS_DOCUMENT_TABLE,
  SEARCH_FTS_TABLE,
  compileSearchFtsQuery,
} from "@/lib/cloudflare/search-fts";
import { getAppBaseUrl } from "@/lib/seo/metadata";

/**
 * D1-native CCL/ChatGPT metasearch backend.
 *
 * The matching page (bounded ids, rank and publication date) is read from the
 * disposable `worldcons_search` projection (`search_fts` JOIN `search_documents`)
 * and every public display field is hydrated from the authoritative
 * `worldcons_core` D1 tables (`article_publications_p3` + the published
 * `article_content_versions_p3` snapshot, plus `article_tags`/`tags`). The
 * PostgREST/RPC dependency is gone: this module imports no Supabase client and
 * reads no Supabase environment.
 *
 * Ranking reproduces the retired `cclmetasearch_search_v1` contract:
 * - `relevance`: rank DESC, then published date DESC NULLS LAST, then id ASC;
 * - `latest`: published date DESC NULLS LAST, then rank DESC, then id ASC.
 * `relevance_score` is `-bm25(search_fts, ...)` (higher is a better match) and
 * the total is the exact match count. Malformed D1 responses fail closed.
 */

const DEFAULT_DATABASE_TIMEOUT_MS = 8_000;
const MAX_QUERY_LENGTH = 200;
const MAX_LIMIT = 20;
const MAX_OFFSET = 10_000;

const FTS_TABLE = SEARCH_FTS_TABLE;
const DOCUMENT_TABLE = SEARCH_FTS_DOCUMENT_TABLE;
const WEIGHTS = SEARCH_FTS_BM25_WEIGHTS;
const RELEVANCE_EXPRESSION = `-1.0 * bm25(${FTS_TABLE}, ${WEIGHTS.article_id}, ${WEIGHTS.title}, ${WEIGHTS.case_numbers}, ${WEIGHTS.search_text}, ${WEIGHTS.tags_text})`;

const VERSION_COLUMNS = [
  "article_id",
  "slug",
  "source_key",
  "jurisdiction",
  "institution_name",
  "original_url",
  "canonical_url",
  "original_language",
  "original_title",
  "korean_title",
  "original_published_at",
  "discovered_at",
  "fetched_at",
  "summarized_at",
  "summary_json",
  "source_metadata",
] as const;

const TAG_COLUMNS = ["id", "slug", "name", "normalized_name", "type"] as const;

const TABLE_BY_NAME = new Map<string, D1TableDefinition>(d1Schema.tables.map((table) => [table.name, table]));

export async function searchCclMetasearch(input: CclMetasearchSearchInput): Promise<CclMetasearchSearchPage> {
  return searchCclMetasearchWithEnv(input, {
    PUBLIC_SITE_BASE_URL: getAppBaseUrl(),
    CORE_BINDING: getRuntimeD1Binding("worldcons_core"),
    SEARCH_BINDING: getRuntimeD1Binding("worldcons_search"),
    CCL_METASEARCH_DB_TIMEOUT_MS: process.env.CCL_METASEARCH_DB_TIMEOUT_MS,
  });
}

export interface CclMetasearchSearchEnv {
  PUBLIC_SITE_BASE_URL: string;
  /** `worldcons_core` D1 binding (authoritative public rows). */
  CORE_BINDING?: D1RuntimeDatabase | null;
  /** `worldcons_search` D1 binding (disposable search projection). */
  SEARCH_BINDING?: D1RuntimeDatabase | null;
  CCL_METASEARCH_DB_TIMEOUT_MS?: string;
  [key: string]: unknown;
}

export interface CclMetasearchSearchDependencies {
  /** Overrides the `worldcons_core` binding. */
  coreBinding?: D1RuntimeDatabase | null;
  /** Overrides the `worldcons_search` binding. */
  searchBinding?: D1RuntimeDatabase | null;
}

export async function searchCclMetasearchWithEnv(
  input: CclMetasearchSearchInput,
  env: CclMetasearchSearchEnv,
  dependencies: CclMetasearchSearchDependencies = {},
): Promise<CclMetasearchSearchPage> {
  const baseUrl = env.PUBLIC_SITE_BASE_URL.trim();
  if (!baseUrl) throw new Error("The WorldCons public base URL is not configured.");

  const searchBinding = dependencies.searchBinding ?? env.SEARCH_BINDING ?? null;
  const coreBinding = dependencies.coreBinding ?? env.CORE_BINDING ?? null;
  if (!searchBinding || !coreBinding) {
    throw new Error("The WorldCons search database is not configured.");
  }

  const query = validateInput(input);
  const compiled = compileSearchFtsQuery(query.query);

  const work = (async () => {
    const [pageRows, total] = await Promise.all([
      readMatchingPage(searchBinding, compiled.matchExpression, query),
      readExactTotal(searchBinding, compiled.matchExpression),
    ]);
    const items = await hydrateItems(coreBinding, pageRows, baseUrl);
    return { items, total };
  })();

  return withDatabaseTimeout(work, databaseTimeoutMs(env.CCL_METASEARCH_DB_TIMEOUT_MS));
}

type ValidatedQuery = {
  query: string;
  limit: number;
  offset: number;
  sort: "relevance" | "latest";
};

function validateInput(input: CclMetasearchSearchInput): ValidatedQuery {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (query.length === 0 || query.length > MAX_QUERY_LENGTH) {
    throw new Error("The WorldCons search query is invalid.");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIMIT) {
    throw new Error("The WorldCons search limit is invalid.");
  }
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > MAX_OFFSET) {
    throw new Error("The WorldCons search offset is invalid.");
  }
  if (input.sort !== "relevance" && input.sort !== "latest") {
    throw new Error("The WorldCons search sort is invalid.");
  }
  return { query, limit: input.limit, offset: input.offset, sort: input.sort };
}

function pageOrder(sort: ValidatedQuery["sort"]): string {
  const date = `${DOCUMENT_TABLE}.original_published_at`;
  if (sort === "latest") {
    return [`(${date} is null) asc`, `${date} desc`, "relevance_score desc", `${DOCUMENT_TABLE}.article_id asc`].join(", ");
  }
  return ["relevance_score desc", `(${date} is null) asc`, `${date} desc`, `${DOCUMENT_TABLE}.article_id asc`].join(", ");
}

function pageStatement(sort: ValidatedQuery["sort"]): string {
  return [
    `select ${DOCUMENT_TABLE}.article_id as article_id, ${RELEVANCE_EXPRESSION} as relevance_score,`,
    `  ${DOCUMENT_TABLE}.original_published_at as original_published_at`,
    `from ${FTS_TABLE}`,
    `join ${DOCUMENT_TABLE} on ${DOCUMENT_TABLE}.article_id = ${FTS_TABLE}.article_id`,
    `where ${FTS_TABLE} match ?`,
    `order by ${pageOrder(sort)}`,
    "limit ? offset ?",
  ].join("\n");
}

const TOTAL_STATEMENT = [
  "select count(*) as total",
  `from ${FTS_TABLE}`,
  `join ${DOCUMENT_TABLE} on ${DOCUMENT_TABLE}.article_id = ${FTS_TABLE}.article_id`,
  `where ${FTS_TABLE} match ?`,
].join("\n");

interface MatchingRow {
  article_id: string;
  relevance_score: number;
  original_published_at: string | null;
}

async function readMatchingPage(
  binding: D1RuntimeDatabase,
  matchExpression: string,
  query: ValidatedQuery,
): Promise<MatchingRow[]> {
  const rows = await executeRows(binding, pageStatement(query.sort), [matchExpression, query.limit, query.offset]);
  return rows.map(validateMatchingRow);
}

async function readExactTotal(binding: D1RuntimeDatabase, matchExpression: string): Promise<number> {
  const rows = await executeRows(binding, TOTAL_STATEMENT, [matchExpression]);
  if (rows.length !== 1) throw new Error("WorldCons search returned a malformed total.");
  const total = rows[0]?.total;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
    throw new Error("WorldCons search returned a malformed total.");
  }
  return total;
}

function validateMatchingRow(row: Record<string, unknown>): MatchingRow {
  const articleId = row.article_id;
  if (typeof articleId !== "string" || articleId.length === 0) {
    throw new Error("WorldCons search returned a malformed result row.");
  }
  const relevance = row.relevance_score;
  if (typeof relevance !== "number" || !Number.isFinite(relevance)) {
    throw new Error("WorldCons search returned a malformed result row.");
  }
  const published = row.original_published_at;
  if (published !== null && typeof published !== "string") {
    throw new Error("WorldCons search returned a malformed result row.");
  }
  return { article_id: articleId, relevance_score: relevance, original_published_at: published };
}

async function executeRows(
  binding: D1RuntimeDatabase,
  sql: string,
  params: readonly unknown[],
): Promise<Record<string, unknown>[]> {
  const prepared = binding.prepare(sql);
  if (typeof prepared?.bind !== "function") {
    throw new Error("The WorldCons search database is unavailable.");
  }
  const bound = prepared.bind(...params);
  if (typeof bound?.all !== "function") {
    throw new Error("The WorldCons search database is unavailable.");
  }
  const result = await bound.all<Record<string, unknown>>();
  if (result === null || typeof result !== "object") {
    throw new Error("WorldCons search returned a malformed response.");
  }
  if (result.success === false) {
    throw new Error("The WorldCons search query failed.");
  }
  const rows = result.results;
  if (!Array.isArray(rows)) {
    throw new Error("WorldCons search returned a malformed response.");
  }
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("WorldCons search returned a malformed row.");
    }
  }
  return rows;
}

async function hydrateItems(
  binding: D1RuntimeDatabase,
  pageRows: readonly MatchingRow[],
  baseUrl: string,
): Promise<ReturnType<typeof mapCclMetasearchRow>[]> {
  if (pageRows.length === 0) return [];
  const articleIds = pageRows.map((row) => row.article_id);

  const publishedVersionByArticle = await readPublishedVersionIds(binding, articleIds);
  const versionIds = articleIds.map((articleId) => {
    const versionId = publishedVersionByArticle.get(articleId);
    if (!versionId) throw new Error("WorldCons search returned a row with no published core version.");
    return versionId;
  });

  const versions = await read(binding, "article_content_versions_p3", {
    select: [...VERSION_COLUMNS],
    where: [{ column: "id", op: "in", value: versionIds }],
    limit: versionIds.length,
  });
  const versionByArticle = new Map<string, Record<string, unknown>>();
  for (const version of versions) {
    const articleId = version.article_id;
    if (typeof articleId !== "string" || articleId.length === 0) {
      throw new Error("WorldCons core returned a malformed version row.");
    }
    if (!articleIds.includes(articleId)) continue;
    versionByArticle.set(articleId, version);
  }

  const tagsByArticle = await readTagsByArticle(binding, articleIds);

  return pageRows.map((row) => {
    const version = versionByArticle.get(row.article_id);
    if (!version) throw new Error("WorldCons search returned a row with no published core version.");
    const mapperRow: Record<string, unknown> = {
      ...version,
      id: row.article_id,
      summary_json: version.summary_json ?? null,
      source_metadata: version.source_metadata ?? null,
      article_tags: tagsByArticle.get(row.article_id) ?? [],
      relevance_score: row.relevance_score,
    };
    return mapCclMetasearchRow(mapperRow, baseUrl);
  });
}

async function readPublishedVersionIds(
  binding: D1RuntimeDatabase,
  articleIds: readonly string[],
): Promise<Map<string, string>> {
  const rows = await read(binding, "article_publications_p3", {
    select: ["article_id", "version_id", "state"],
    where: [
      { column: "state", value: "published" },
      { column: "article_id", op: "in", value: [...articleIds] },
    ],
    limit: articleIds.length,
  });
  const byArticle = new Map<string, string>();
  for (const row of rows) {
    const articleId = row.article_id;
    const versionId = row.version_id;
    if (typeof articleId !== "string" || articleId.length === 0 || typeof versionId !== "string" || versionId.length === 0) {
      throw new Error("WorldCons core returned a malformed publication row.");
    }
    if (byArticle.has(articleId)) {
      throw new Error("WorldCons core returned an ambiguous published version.");
    }
    byArticle.set(articleId, versionId);
  }
  return byArticle;
}

interface ArticleTagEntry {
  confidence: number | null;
  tags: Record<string, unknown>;
}

async function readTagsByArticle(
  binding: D1RuntimeDatabase,
  articleIds: readonly string[],
): Promise<Map<string, ArticleTagEntry[]>> {
  const links = await read(binding, "article_tags", {
    select: ["article_id", "tag_id", "confidence"],
    where: [{ column: "article_id", op: "in", value: [...articleIds] }],
  });
  const tagIds = uniqueStrings(links.map((link) => link.tag_id));
  const tags = tagIds.length > 0
    ? await read(binding, "tags", {
        select: [...TAG_COLUMNS],
        where: [{ column: "id", op: "in", value: tagIds }],
        limit: tagIds.length,
      })
    : [];
  const tagById = new Map<string, Record<string, unknown>>();
  for (const tag of tags) {
    if (typeof tag.id !== "string") throw new Error("WorldCons core returned a malformed tag row.");
    tagById.set(tag.id, tag);
  }

  const byArticle = new Map<string, ArticleTagEntry[]>();
  for (const link of links) {
    const articleId = typeof link.article_id === "string" ? link.article_id : null;
    const tagId = typeof link.tag_id === "string" ? link.tag_id : null;
    if (!articleId || !tagId) continue;
    const tag = tagById.get(tagId);
    if (!tag) continue;
    const entries = byArticle.get(articleId) ?? [];
    entries.push({ confidence: numericConfidence(link.confidence), tags: tag });
    byArticle.set(articleId, entries);
  }
  for (const entries of byArticle.values()) {
    entries.sort((left, right) => stringField(left.tags.slug).localeCompare(stringField(right.tags.slug)));
  }
  return byArticle;
}

function read(
  binding: D1RuntimeDatabase,
  table: string,
  request: {
    select?: readonly string[];
    where?: readonly { column: string; op?: "eq" | "in"; value: unknown }[];
    limit?: number | null;
  },
): Promise<Record<string, unknown>[]> {
  const definition = TABLE_BY_NAME.get(table);
  if (!definition) throw new Error(`WorldCons core has no D1 table ${table}.`);
  return runD1RuntimeRead({
    binding,
    table: definition,
    select: request.select,
    where: request.where,
    limit: request.limit ?? null,
  });
}

function numericConfidence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function databaseTimeoutMs(value?: string) {
  const configured = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(configured)) return DEFAULT_DATABASE_TIMEOUT_MS;
  return Math.min(Math.max(configured, 1_000), 15_000);
}

function withDatabaseTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The WorldCons search query timed out.")), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
