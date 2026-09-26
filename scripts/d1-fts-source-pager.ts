import {
  parseSupabaseLinkedRows,
  type SupabaseLinkedQueryRunner,
} from "@/lib/cloudflare/d1/convert/supabase-linked-source";
import { renderSqlLiteral } from "@/lib/cloudflare/d1/import/literal";
import type {
  SearchBaseArticleRow,
  SearchPublicationP3Row,
  SearchVersionP3Row,
} from "@/lib/cloudflare/search-projection";

/**
 * M7.7-B read-only full-scope FTS source pager (operator-only).
 *
 * Supabase remains the sole production authority; this module only reads. It
 * replaces the one-shot `createSupabaseCanaryReader.readSources` path for linked
 * production FTS evidence with a dedicated pager that:
 *
 * - authors every SELECT itself and inlines values through `renderSqlLiteral`,
 *   so no unguarded text reaches the linked Supabase CLI;
 * - pages `article_publications_p3` by a stable `article_id` cursor (50-100
 *   rows/page), selecting ONLY the columns the projection/FTS path needs;
 * - NEVER selects `embedding` (neither the version nor any artifact vector);
 * - reads the full `public_article_projection_p3` id set first (ceiling 5000),
 *   restricts the paged published rows to exactly those ids, and builds the
 *   local projection from that like-for-like scope;
 * - fails closed, before any rank evaluation, unless the locally projected
 *   article-id set exactly equals the production projection id set.
 *
 * The scope summary it exposes is content-free (counts + a boolean): production
 * ids and local ids are never copied into an evidence report.
 */

/** Default and bounded page size for the stable `article_id` cursor. */
export const FTS_SOURCE_PAGE_SIZE = 100;
export const FTS_SOURCE_MIN_PAGE_SIZE = 50;
export const FTS_SOURCE_MAX_PAGE_SIZE = 100;

/** Read-only ceiling for the full production projection id set. */
export const PRODUCTION_PROJECTION_CEILING = 5000;

export interface FtsSourceRows {
  publications: SearchPublicationP3Row[];
  versions: SearchVersionP3Row[];
  articles: SearchBaseArticleRow[];
  /** Sorted, unique published article ids (one per projected candidate). */
  articleIds: string[];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Reads the full `public_article_projection_p3` id set (read-only, ids only). */
export function buildProductionProjectionIdSql(ceiling: number = PRODUCTION_PROJECTION_CEILING): string {
  if (!Number.isInteger(ceiling) || ceiling <= 0) throw new Error("ceiling must be a positive integer");
  return `select id from public.public_article_projection_p3 order by id limit ${ceiling}`;
}

export interface FtsSourcePageQuery {
  /** Exclusive stable `article_id` cursor; null for the first page. */
  afterArticleId: string | null;
  limit: number;
}

/**
 * Builds one deterministic, read-only published-source page. The projection/FTS
 * path needs publication state/timestamps/revisions, version
 * source/jurisdiction/type/language/titles/institution/cleaned_text/summary/
 * source_metadata/case_key/content_hash and the base `review_state`; an
 * embedding is never selected.
 */
export function buildFtsSourcePageSql(query: FtsSourcePageQuery): string {
  const { afterArticleId, limit } = query;
  if (!Number.isInteger(limit) || limit < FTS_SOURCE_MIN_PAGE_SIZE || limit > FTS_SOURCE_MAX_PAGE_SIZE) {
    throw new Error(`page size must be an integer between ${FTS_SOURCE_MIN_PAGE_SIZE} and ${FTS_SOURCE_MAX_PAGE_SIZE}`);
  }
  if (afterArticleId !== null && afterArticleId.length === 0) {
    throw new Error("cursor must be null or a non-empty article id");
  }
  const cursorClause = afterArticleId === null ? "" : ` and p.article_id > ${renderSqlLiteral(afterArticleId)}`;
  return (
    "select\n" +
    "  p.id as publication_id,\n" +
    "  p.article_id as publication_article_id,\n" +
    "  p.state as publication_state,\n" +
    "  p.version_id as publication_version_id,\n" +
    "  p.revision as publication_revision,\n" +
    "  p.published_at as publication_published_at,\n" +
    "  p.withdrawn_at as publication_withdrawn_at,\n" +
    "  p.created_at as publication_created_at,\n" +
    "  p.updated_at as publication_updated_at,\n" +
    "  v.id as version_id,\n" +
    "  v.article_id as version_article_id,\n" +
    "  v.revision as version_revision,\n" +
    "  v.slug as slug,\n" +
    "  v.source_key as source_key,\n" +
    "  v.jurisdiction as jurisdiction,\n" +
    "  v.institution_name as institution_name,\n" +
    "  v.content_type as content_type,\n" +
    "  v.original_language as original_language,\n" +
    "  v.original_title as original_title,\n" +
    "  v.korean_title as korean_title,\n" +
    "  v.original_published_at as original_published_at,\n" +
    "  v.cleaned_text as cleaned_text,\n" +
    "  v.summary_json as summary_json,\n" +
    "  v.source_metadata as source_metadata,\n" +
    "  v.case_key as case_key,\n" +
    "  v.created_at as version_created_at,\n" +
    "  v.fetched_at as fetched_at,\n" +
    "  v.summarized_at as summarized_at,\n" +
    "  v.content_hash as content_hash,\n" +
    "  a.review_state as article_review_state\n" +
    "from public.article_publications_p3 p\n" +
    "join public.article_content_versions_p3 v on v.id = p.version_id and v.article_id = p.article_id\n" +
    "left join public.articles a on a.id = p.article_id\n" +
    "where p.state = 'published'" +
    cursorClause +
    "\norder by p.article_id\n" +
    `limit ${limit}`
  );
}

/** Maps one parsed page's rows into projection source rows (never a vector). */
export function parseFtsSourceRows(rows: readonly Record<string, unknown>[]): FtsSourceRows {
  const publications: SearchPublicationP3Row[] = [];
  const versions: SearchVersionP3Row[] = [];
  const articles: SearchBaseArticleRow[] = [];
  for (const row of rows) {
    publications.push({
      id: asString(row.publication_id),
      article_id: asString(row.publication_article_id),
      state: asString(row.publication_state),
      version_id: asString(row.publication_version_id),
      revision: asNullableString(row.publication_revision),
      published_at: asNullableString(row.publication_published_at),
      withdrawn_at: asNullableString(row.publication_withdrawn_at),
      created_at: asString(row.publication_created_at),
      updated_at: asNullableString(row.publication_updated_at),
    });
    versions.push({
      id: asString(row.version_id),
      article_id: asString(row.version_article_id),
      revision: asNullableString(row.version_revision),
      slug: asNullableString(row.slug),
      source_key: asString(row.source_key),
      jurisdiction: asString(row.jurisdiction),
      institution_name: asNullableString(row.institution_name),
      content_type: asString(row.content_type),
      original_language: asNullableString(row.original_language),
      original_title: asNullableString(row.original_title),
      korean_title: asNullableString(row.korean_title),
      original_published_at: asNullableString(row.original_published_at),
      cleaned_text: asNullableString(row.cleaned_text),
      summary_json: row.summary_json ?? null,
      source_metadata: row.source_metadata ?? null,
      case_key: asNullableString(row.case_key),
      created_at: asString(row.version_created_at),
      fetched_at: asNullableString(row.fetched_at),
      summarized_at: asNullableString(row.summarized_at),
      content_hash: asNullableString(row.content_hash),
    });
    articles.push({
      id: asString(row.publication_article_id),
      review_state: asNullableString(row.article_review_state),
    });
  }
  return { publications, versions, articles, articleIds: [] };
}

function compareArticleIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Deterministically combines pages: de-duplicates by id and sorts by article_id. */
export function combineFtsSourcePages(pages: readonly FtsSourceRows[]): FtsSourceRows {
  const publicationById = new Map<string, SearchPublicationP3Row>();
  const versionById = new Map<string, SearchVersionP3Row>();
  const articleById = new Map<string, SearchBaseArticleRow>();
  for (const page of pages) {
    for (const publication of page.publications) if (!publicationById.has(publication.id)) publicationById.set(publication.id, publication);
    for (const version of page.versions) if (!versionById.has(version.id)) versionById.set(version.id, version);
    for (const article of page.articles) if (!articleById.has(article.id)) articleById.set(article.id, article);
  }
  const publications = [...publicationById.values()].sort((a, b) => compareArticleIds(a.article_id, b.article_id));
  const articleIds = [...new Set(publications.map((publication) => publication.article_id))].sort(compareArticleIds);
  return {
    publications,
    versions: [...versionById.values()].sort((a, b) => compareArticleIds(a.article_id, b.article_id)),
    articles: [...articleById.values()].sort((a, b) => compareArticleIds(a.id, b.id)),
    articleIds,
  };
}

/** Restricts paged published rows to exactly the production projection id set. */
export function restrictToProductionIds(rows: FtsSourceRows, productionProjectionIds: ReadonlySet<string>): FtsSourceRows {
  const keep = (articleId: string): boolean => productionProjectionIds.has(articleId);
  const publications = rows.publications.filter((publication) => keep(publication.article_id));
  const versions = rows.versions.filter((version) => keep(version.article_id));
  const articles = rows.articles.filter((article) => keep(article.id));
  const articleIds = [...new Set(publications.map((publication) => publication.article_id))].sort(compareArticleIds);
  return { publications, versions, articles, articleIds };
}

/** Reads the full production projection id set, failing closed on the ceiling. */
export async function readProductionProjectionIds(
  query: SupabaseLinkedQueryRunner,
  ceiling: number = PRODUCTION_PROJECTION_CEILING,
): Promise<Set<string>> {
  const rows = parseSupabaseLinkedRows(await query(buildProductionProjectionIdSql(ceiling)));
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.id === "string" && row.id.length > 0) ids.add(row.id);
  }
  if (ids.size >= ceiling) {
    throw new Error(
      `scope-ceiling-exceeded: production projection id set reached the read-only ceiling ${ceiling}; full like-for-like scope cannot be guaranteed`,
    );
  }
  return ids;
}

export interface FtsSourcePagerOptions {
  /** Page size; defaults to 100 and must be within 50-100. */
  pageSize?: number;
}

export interface FtsSourcePagerResult {
  /** All published source rows fetched, before projection-id restriction. */
  published: FtsSourceRows;
  /** Publications fetched before restriction. */
  sourceRowsFetched: number;
  pagesRead: number;
}

/**
 * Pages every published `article_publications_p3` row by a stable `article_id`
 * cursor. The caller restricts the result to the production projection ids.
 */
export async function readFtsSourcePager(
  query: SupabaseLinkedQueryRunner,
  options: FtsSourcePagerOptions = {},
): Promise<FtsSourcePagerResult> {
  const pageSize = options.pageSize ?? FTS_SOURCE_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < FTS_SOURCE_MIN_PAGE_SIZE || pageSize > FTS_SOURCE_MAX_PAGE_SIZE) {
    throw new Error(`page size must be an integer between ${FTS_SOURCE_MIN_PAGE_SIZE} and ${FTS_SOURCE_MAX_PAGE_SIZE}`);
  }
  const pages: FtsSourceRows[] = [];
  let afterArticleId: string | null = null;
  let pagesRead = 0;
  for (;;) {
    const sql = buildFtsSourcePageSql({ afterArticleId, limit: pageSize });
    const page = parseFtsSourceRows(parseSupabaseLinkedRows(await query(sql)));
    if (page.publications.length === 0) break;
    pages.push(page);
    pagesRead += 1;
    const lastArticleId = page.publications[page.publications.length - 1].article_id;
    if (page.publications.length < pageSize) break;
    if (lastArticleId === afterArticleId) throw new Error("pager cursor did not advance");
    afterArticleId = lastArticleId;
  }
  const published = combineFtsSourcePages(pages);
  return { published, sourceRowsFetched: published.publications.length, pagesRead };
}

export interface FtsProjectionScopeInput {
  productionProjectionIds: ReadonlySet<string>;
  localArticleIds: ReadonlySet<string>;
  sourceRowsFetched: number;
}

/** Content-free scope report (counts + boolean only; never any id). */
export interface FtsProjectionScope {
  productionProjectionIds: number;
  sourceRowsFetched: number;
  localDocuments: number;
  missingIds: number;
  extraIds: number;
  scopeValid: boolean;
}

function countMissing(from: ReadonlySet<string>, present: ReadonlySet<string>): number {
  let missing = 0;
  for (const id of from) if (!present.has(id)) missing += 1;
  return missing;
}

/** Compares the production projection id set and the local projected id set. */
export function evaluateFtsProjectionScope(input: FtsProjectionScopeInput): FtsProjectionScope {
  const missingIds = countMissing(input.productionProjectionIds, input.localArticleIds);
  const extraIds = countMissing(input.localArticleIds, input.productionProjectionIds);
  return {
    productionProjectionIds: input.productionProjectionIds.size,
    sourceRowsFetched: input.sourceRowsFetched,
    localDocuments: input.localArticleIds.size,
    missingIds,
    extraIds,
    scopeValid: missingIds === 0 && extraIds === 0,
  };
}

/**
 * Fails closed with an explicit scope-too-small error when an operator asks for
 * a production window below the full projection count.
 */
export function assertProductionScopeLargeEnough(productionProjectionIds: number, requestedMaxArticles: number): void {
  if (!Number.isInteger(requestedMaxArticles) || requestedMaxArticles <= 0) {
    throw new Error("--max-articles must be a positive integer");
  }
  if (requestedMaxArticles < productionProjectionIds) {
    throw new Error(
      `scope-too-small: --max-articles=${requestedMaxArticles} is below the production projection count ${productionProjectionIds}; full like-for-like scope is required and no metrics are produced`,
    );
  }
}

/** Fails closed before rank evaluation unless the two id sets are exactly equal. */
export function assertFullProjectionScope(scope: FtsProjectionScope): void {
  if (!scope.scopeValid) {
    throw new Error(
      `scope-mismatch: local projected article-id set is not exactly the production projection id set ` +
        `(productionProjectionIds=${scope.productionProjectionIds}, localDocuments=${scope.localDocuments}, ` +
        `missingIds=${scope.missingIds}, extraIds=${scope.extraIds}); rank evaluation is not performed`,
    );
  }
}
