import { D1_SHADOW_DEFAULT_MAX_ROWS } from "@/lib/cloudflare/d1/shadow/config";
import {
  runD1RuntimeRead,
  type D1RuntimeReadOrder,
  type D1RuntimeReadPredicate,
} from "@/lib/cloudflare/d1/runtime-read";
import { getRuntimeD1Binding, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { d1Schema } from "@/lib/cloudflare/d1/schema";
import type { D1TableDefinition } from "@/lib/cloudflare/d1/types";
import {
  articleMappingOptions,
  articleRowToItem,
  normalizePagination,
  type SupabaseArticleRow,
  type SupabaseArticleTagRow,
} from "@/lib/article-reads/shared";
import { isPublishableListItem } from "@/lib/ingest/publishability";
import { D1ShadowTruncatedError } from "@/lib/reference-reads/d1-repository";
import type { SupabaseTagRow } from "@/lib/reference-reads/shared";
import { rangeStartIso } from "@/lib/utils/dates";
import type { ArticleDetail, ArticleListItem, ArticleListFilters, ArticleListResult } from "@/lib/db/types";
import type {
  ArticleReadOptions,
  ArticleReadRepository,
  ArticleReadSelect,
  ArticleSourceTextRecord,
  RelatedArticleIdsOptions,
  SitemapArticleEntry,
  TopViewedArticleFilters,
} from "@/lib/article-reads/types";

/**
 * M6.3 D1-backed article reads.
 *
 * This is the shadow adapter for the six-method `lib/article-reads` seam. It is
 * only ever invoked from the background shadow wrapper against the base
 * `articles` relation (and the migrated `article_tags`/`tags`/
 * `article_view_counts` tables); the publication projection and the case-catalog
 * V4 detail relation are NOT migrated to D1 and are skipped by the wrapper
 * before any D1 call. The shared article row mapping and publishability
 * semantics are reused from the authoritative adapter so the only difference
 * between the two results is the storage engine.
 *
 * Every read is read-only and bounded; an overflow past `maxRows` raises the
 * typed `D1ShadowTruncatedError` so the wrapper emits a skip instead of
 * comparing a partial result.
 */
export class D1ArticleShadowSkipError extends Error {
  readonly code = "d1_article_shadow.skip";
  readonly reason: string;
  readonly method: string;
  constructor(reason: string, method: string) {
    super(`D1 article shadow skipped ${method}: ${reason}`);
    this.name = "D1ArticleShadowSkipError";
    this.reason = reason;
    this.method = method;
  }
}

export interface D1ArticleReadDependencies {
  /** The `worldcons_core` binding. Resolved from the runtime slot when omitted. */
  binding?: D1RuntimeDatabase | null;
  /** Bounded shadow read limit. */
  maxRows?: number;
}

const LIST_COLUMNS = [
  "id",
  "slug",
  "source_key",
  "jurisdiction",
  "institution_name",
  "content_type",
  "original_url",
  "canonical_url",
  "original_language",
  "original_title",
  "korean_title",
  "original_published_at",
  "discovered_at",
  "fetched_at",
  "summarized_at",
  "status",
  "summary_json",
  "source_metadata",
  "catalog_ai_stale_v4",
] as const;

const PAGE_COLUMNS = [...LIST_COLUMNS, "content_hash", "error_metadata"] as const;

const DETAIL_COLUMNS = [
  ...PAGE_COLUMNS,
  "cleaned_text",
  "raw_text_storage_ref",
  "raw_text_blob_hash",
  "raw_text_blob_size",
  "raw_text_externalized_at",
  "raw_text_blob_contract_version",
] as const;

const SOURCE_TEXT_COLUMNS = [
  "slug",
  "status",
  "source_key",
  "source_metadata",
  "original_url",
  "cleaned_text",
  "content_hash",
  "catalog_ai_stale_v4",
] as const;

const TAG_COLUMNS = [
  "id",
  "slug",
  "name",
  "normalized_name",
  "type",
  "description",
  "article_count",
  "latest_article_at",
] as const;

const LIST_ORDER: D1RuntimeReadOrder[] = [
  { column: "original_published_at", direction: "desc", nulls: "last" },
  { column: "id", direction: "asc" },
];

function tableByName(schema = d1Schema): Map<string, D1TableDefinition> {
  return new Map(schema.tables.map((table) => [table.name, table]));
}

function requireCore(dependencies: D1ArticleReadDependencies): D1RuntimeDatabase {
  const binding = dependencies.binding ?? getRuntimeD1Binding("worldcons_core");
  if (!binding) throw new Error("worldcons_core D1 binding is not available");
  return binding;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Mirrors the PostgREST `source_metadata->collection->>publishable = 'true'`
 * predicate: the canonical JSON text of `publishable` is compared as text, so a
 * JSON boolean `true` and the string `"true"` both count.
 */
function isTextuallyPublishable(row: { source_metadata?: unknown }): boolean {
  const metadata = asRecord(row.source_metadata);
  if (!metadata) return false;
  const collection = asRecord(metadata.collection);
  if (!collection) return false;
  const publishable = collection.publishable;
  return publishable === true || publishable === "true";
}

/**
 * Reproduces the PostgREST projection aliases (`one_line_summary`,
 * `resolution_type`, `case_number`) and drops the columns the authoritative list
 * projection does not select, so the shared `articleRowToItem` mapper produces
 * the exact same shape from a D1 row.
 */
function articleRowForSelect(row: Record<string, unknown>, select: ArticleReadSelect): SupabaseArticleRow {
  const summary = asRecord(row.summary_json);
  const coreSummary = summary ? asRecord(summary.summary)?.coreSummary : null;
  const oneLine = Array.isArray(coreSummary) && coreSummary.length > 0 ? coreSummary[0] : null;
  const metadata = asRecord(row.source_metadata);
  const projected: Record<string, unknown> = {
    ...row,
    one_line_summary: oneLine ?? null,
    resolution_type: metadata?.resolutionType ?? null,
    case_number: metadata?.caseNumber ?? null,
  };
  if (select === "list") {
    projected.summary_json = undefined;
    projected.source_metadata = undefined;
  } else if (select === "detail") {
    // `raw_text` is relocated to R2 in D1, so the inline text is always absent;
    // the authoritative column would be null for an externalized row.
    projected.raw_text = row.raw_text ?? null;
  }
  return projected as unknown as SupabaseArticleRow;
}

function confidenceValue(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function createD1ArticleReadRepository(
  dependencies: D1ArticleReadDependencies = {},
): ArticleReadRepository {
  const maxRows = dependencies.maxRows ?? D1_SHADOW_DEFAULT_MAX_ROWS;
  const tables = tableByName();

  function requireTable(name: string): D1TableDefinition {
    const table = tables.get(name);
    if (!table) throw new Error(`D1 schema has no table ${name}`);
    return table;
  }

  async function read(
    binding: D1RuntimeDatabase,
    table: string,
    request: {
      select?: readonly string[];
      where?: readonly D1RuntimeReadPredicate[];
      orderBy?: readonly (string | D1RuntimeReadOrder)[];
      limit: number;
      offset?: number;
    },
  ): Promise<Record<string, unknown>[]> {
    return runD1RuntimeRead({
      binding,
      table: requireTable(table),
      select: request.select,
      where: request.where,
      orderBy: request.orderBy,
      limit: request.limit,
      offset: request.offset,
    });
  }

  async function hydrateArticleTags(
    binding: D1RuntimeDatabase,
    rows: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const articleIds = uniqueStrings(rows.map((row) => row.id));
    if (articleIds.length === 0) return rows.map((row) => ({ ...row, article_tags: [] }));

    const links = await read(binding, "article_tags", {
      select: ["article_id", "tag_id", "confidence"],
      where: [{ column: "article_id", op: "in", value: articleIds }],
      orderBy: [
        { column: "article_id", direction: "asc" },
        { column: "tag_id", direction: "asc" },
      ],
      limit: maxRows + 1,
    });
    if (links.length > maxRows) throw new D1ShadowTruncatedError("hydrateArticleTags");

    const tagIds = uniqueStrings(links.map((link) => link.tag_id));
    const tagRows =
      tagIds.length === 0
        ? []
        : await read(binding, "tags", {
            select: [...TAG_COLUMNS],
            where: [{ column: "id", op: "in", value: tagIds }],
            orderBy: ["id"],
            limit: maxRows + 1,
          });
    if (tagRows.length > maxRows) throw new D1ShadowTruncatedError("hydrateArticleTags");

    const tagById = new Map(tagRows.map((tag) => [String(tag.id), tag]));
    const linksByArticle = new Map<string, Record<string, unknown>[]>();
    for (const link of links) {
      const articleId = typeof link.article_id === "string" ? link.article_id : null;
      if (!articleId) continue;
      const list = linksByArticle.get(articleId) ?? [];
      list.push(link);
      linksByArticle.set(articleId, list);
    }

    return rows.map((row) => {
      const articleId = typeof row.id === "string" ? row.id : null;
      const articleTags: SupabaseArticleTagRow[] = (articleId ? linksByArticle.get(articleId) ?? [] : []).flatMap(
        (link) => {
          const tag = typeof link.tag_id === "string" ? tagById.get(link.tag_id) : undefined;
          if (!tag) return [];
          const confidence = confidenceValue(link.confidence);
          return [{ confidence, tags: tag as unknown as SupabaseTagRow }];
        },
      );
      return { ...row, article_tags: articleTags };
    });
  }

  async function attachViewCounts<T extends ArticleListItem>(binding: D1RuntimeDatabase, items: T[]): Promise<T[]> {
    if (items.length === 0) return items;
    const slugs = uniqueStrings(items.map((item) => item.slug));
    if (slugs.length === 0) return items;
    const rows = await read(binding, "article_view_counts", {
      select: ["article_slug", "view_count"],
      where: [{ column: "article_slug", op: "in", value: slugs }],
      limit: maxRows + 1,
    });
    if (rows.length > maxRows) throw new D1ShadowTruncatedError("attachViewCounts");
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (typeof row.article_slug !== "string") continue;
      counts.set(row.article_slug, Number(row.view_count ?? 0));
    }
    return items.map((item) => ({ ...item, viewCount: counts.get(item.slug) ?? 0 }));
  }

  async function tagIdsForTag(binding: D1RuntimeDatabase, tag: string): Promise<string[]> {
    const bySlug = await read(binding, "tags", {
      select: ["id"],
      where: [{ column: "slug", value: tag }],
      limit: maxRows + 1,
    });
    if (bySlug.length > maxRows) throw new D1ShadowTruncatedError("tagIdsForTag");
    const byName = await read(binding, "tags", {
      select: ["id"],
      where: [{ column: "name", value: tag }],
      limit: maxRows + 1,
    });
    if (byName.length > maxRows) throw new D1ShadowTruncatedError("tagIdsForTag");
    return uniqueStrings([...bySlug.map((row) => row.id), ...byName.map((row) => row.id)]);
  }

  async function articleIdsForTagIds(binding: D1RuntimeDatabase, tagIds: string[]): Promise<string[]> {
    const rows = await read(binding, "article_tags", {
      select: ["article_id"],
      where: [{ column: "tag_id", op: "in", value: tagIds }],
      limit: maxRows + 1,
    });
    if (rows.length > maxRows) throw new D1ShadowTruncatedError("articleIdsForTagIds");
    return uniqueStrings(rows.map((row) => row.article_id));
  }

  async function listArticles(filters: ArticleListFilters = {}): Promise<ArticleListResult> {
    const { page, pageSize } = normalizePagination(filters.page, filters.pageSize);
    const countMode = filters.count ?? "exact";
    const empty = (): ArticleListResult => ({
      items: [],
      pageInfo: { page, pageSize, total: 0, hasMore: false, totalIsExact: true },
    });

    if (filters.ids && filters.ids.length === 0) return empty();
    if (countMode === "planned" || countMode === "estimated") {
      throw new D1ArticleShadowSkipError("unsupported_count_mode", "listArticles");
    }
    if (filters.ids && filters.ids.length > maxRows) {
      throw new D1ArticleShadowSkipError("unbounded", "listArticles");
    }

    const binding = requireCore(dependencies);
    let taggedArticleIds: string[] | null = null;
    if (filters.tag) {
      const tagIds = await tagIdsForTag(binding, filters.tag);
      if (tagIds.length === 0) return empty();
      taggedArticleIds = await articleIdsForTagIds(binding, tagIds);
      if (taggedArticleIds.length === 0) return empty();
    }

    const where: D1RuntimeReadPredicate[] = [];
    if (!filters.includeUnpublished) {
      where.push({ column: "status", value: "summarized" });
      where.push({ column: "catalog_ai_stale_v4", value: 0 });
    }
    if (filters.ids) where.push({ column: "id", op: "in", value: filters.ids });
    if (filters.source) where.push({ column: "source_key", value: filters.source });
    if (filters.jurisdiction) where.push({ column: "jurisdiction", value: filters.jurisdiction });
    if (filters.type) where.push({ column: "content_type", value: filters.type });
    if (filters.language) where.push({ column: "original_language", value: filters.language });
    if (taggedArticleIds) where.push({ column: "id", op: "in", value: taggedArticleIds });
    const startIso = rangeStartIso(filters.range);
    if (startIso) where.push({ column: "original_published_at", op: "gte", value: startIso });

    const rows = await read(binding, "articles", {
      select: [...LIST_COLUMNS],
      where,
      orderBy: LIST_ORDER,
      limit: maxRows + 1,
    });
    if (rows.length > maxRows) throw new D1ShadowTruncatedError("listArticles");

    const matched = filters.includeUnpublished ? rows : rows.filter((row) => isTextuallyPublishable(row));
    const from = (page - 1) * pageSize;
    const pageRows = matched.slice(from, from + pageSize);
    const hydrated = await hydrateArticleTags(binding, pageRows);
    let items = hydrated.map((row) =>
      articleRowToItem(articleRowForSelect(row, "list"), { includeSummaryJson: false, includeDetailFields: false }),
    );
    if (filters.includeViewCounts !== false) items = await attachViewCounts(binding, items);

    const hasMore = from + pageSize < matched.length;
    const minimumTotal = from + items.length + (hasMore ? 1 : 0);
    const total = countMode === "exact" ? Math.max(matched.length, minimumTotal) : minimumTotal;
    return {
      items,
      pageInfo: { page, pageSize, total, hasMore, totalIsExact: countMode === "exact" },
    };
  }

  async function getArticleBySelect(
    slug: string,
    select: ArticleReadSelect,
    options: ArticleReadOptions = {},
  ): Promise<ArticleDetail | null> {
    const binding = requireCore(dependencies);
    const where: D1RuntimeReadPredicate[] = [{ column: "slug", value: slug }];
    if (!options.includeUnpublished) {
      where.push({ column: "status", value: "summarized" });
      where.push({ column: "catalog_ai_stale_v4", value: 0 });
    }
    const columns = select === "detail" ? DETAIL_COLUMNS : select === "page" ? PAGE_COLUMNS : LIST_COLUMNS;
    const rows = await read(binding, "articles", { select: [...columns], where, limit: 1 });
    const row = rows[0];
    if (!row) return null;
    if (!options.includeUnpublished) {
      if (!isTextuallyPublishable(row)) return null;
      if (row.source_metadata !== undefined && !isPublishableListItem(row as unknown as SupabaseArticleRow)) return null;
    }
    const hydrated = await hydrateArticleTags(binding, [row]);
    return articleRowToItem(articleRowForSelect(hydrated[0], select), articleMappingOptions(select));
  }

  async function getArticleSourceTextBySlug(
    slug: string,
    options: ArticleReadOptions = {},
  ): Promise<ArticleSourceTextRecord | null> {
    const binding = requireCore(dependencies);
    const where: D1RuntimeReadPredicate[] = [{ column: "slug", value: slug }];
    if (!options.includeUnpublished) {
      where.push({ column: "status", value: "summarized" });
      where.push({ column: "catalog_ai_stale_v4", value: 0 });
    }
    const rows = await read(binding, "articles", { select: [...SOURCE_TEXT_COLUMNS], where, limit: 1 });
    const row = rows[0];
    if (!row) return null;
    if (!options.includeUnpublished) {
      if (!isTextuallyPublishable(row)) return null;
      if (row.source_metadata !== undefined && !isPublishableListItem(row as unknown as SupabaseArticleRow)) return null;
    }
    return {
      slug: typeof row.slug === "string" ? row.slug : slug,
      sourceKey: (row.source_key as string | null | undefined) ?? null,
      sourceMetadata: (asRecord(row.source_metadata) as unknown as Record<string, unknown> | null) ?? null,
      officialUrl: (row.original_url as string | null | undefined) ?? null,
      cleanedText: (row.cleaned_text as string | null | undefined) ?? null,
      contentHash: (row.content_hash as string | null | undefined) ?? null,
    };
  }

  async function listPublicSitemapArticles(): Promise<SitemapArticleEntry[]> {
    const binding = requireCore(dependencies);
    const rows = await read(binding, "articles", {
      select: ["slug", "summarized_at", "fetched_at", "discovered_at", "status", "catalog_ai_stale_v4", "source_metadata"],
      where: [
        { column: "status", value: "summarized" },
        { column: "catalog_ai_stale_v4", value: 0 },
      ],
      orderBy: LIST_ORDER,
      limit: maxRows + 1,
    });
    if (rows.length > maxRows) throw new D1ShadowTruncatedError("listPublicSitemapArticles");
    return rows.filter((row) => isTextuallyPublishable(row)).flatMap((row) => {
      if (typeof row.slug !== "string" || row.slug.length === 0) return [];
      const lastModified =
        (row.summarized_at as string | null | undefined) ||
        (row.fetched_at as string | null | undefined) ||
        (row.discovered_at as string | null | undefined) ||
        null;
      return [{ slug: row.slug, lastModified }];
    });
  }

  async function listTopViewedArticles(
    limit = 5,
    filters: TopViewedArticleFilters = {},
  ): Promise<ArticleListItem[]> {
    const binding = requireCore(dependencies);
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 20) : 5;
    const fallback = async () => (await listArticles({ ...filters, pageSize: safeLimit, count: "none" })).items;

    if (filters.tag) return fallback();

    const viewLimit = Math.max(safeLimit * 4, safeLimit);
    const readLimit = maxRows + 1;
    let viewRows: Record<string, unknown>[];
    try {
      // `view_count` is decimal TEXT in D1, so ordering is done numerically in
      // JS over the bounded full scan rather than lexicographically in SQL.
      viewRows = await read(binding, "article_view_counts", {
        select: ["article_slug", "view_count"],
        orderBy: [],
        limit: readLimit,
      });
    } catch (error) {
      if (error instanceof D1ShadowTruncatedError) throw error;
      return fallback();
    }
    if (viewRows.length > maxRows) throw new D1ShadowTruncatedError("listTopViewedArticles");

    const ranked = viewRows
      .filter((row) => typeof row.article_slug === "string" && row.article_slug.length > 0)
      .map((row) => ({ slug: String(row.article_slug), viewCount: Number(row.view_count ?? 0) }))
      .sort((left, right) => right.viewCount - left.viewCount);
    if (ranked.length === 0) return fallback();

    if (ranked.length > safeLimit && ranked[safeLimit].viewCount === ranked[safeLimit - 1].viewCount) {
      throw new D1ArticleShadowSkipError("ambiguous_ranking", "listTopViewedArticles");
    }

    const probe = ranked.slice(0, viewLimit);
    const slugs = uniqueStrings(probe.map((entry) => entry.slug));
    const viewCountBySlug = new Map(probe.map((entry) => [entry.slug, entry.viewCount]));

    const where: D1RuntimeReadPredicate[] = [
      { column: "status", value: "summarized" },
      { column: "catalog_ai_stale_v4", value: 0 },
      { column: "slug", op: "in", value: slugs },
    ];
    if (filters.source) where.push({ column: "source_key", value: filters.source });
    if (filters.jurisdiction) where.push({ column: "jurisdiction", value: filters.jurisdiction });
    if (filters.type) where.push({ column: "content_type", value: filters.type });
    if (filters.language) where.push({ column: "original_language", value: filters.language });
    const startIso = rangeStartIso(filters.range);
    if (startIso) where.push({ column: "original_published_at", op: "gte", value: startIso });

    const articleRows = await read(binding, "articles", {
      select: [...LIST_COLUMNS],
      where,
      limit: Math.min(slugs.length + 1, maxRows + 1),
    });
    if (articleRows.length > slugs.length || articleRows.length > maxRows) {
      throw new D1ShadowTruncatedError("listTopViewedArticles");
    }
    const publishable = articleRows.filter((row) => isTextuallyPublishable(row));
    if (publishable.length === 0) return fallback();

    const hydrated = await hydrateArticleTags(binding, publishable);
    const order = new Map(slugs.map((slug, index) => [slug, index]));
    return hydrated
      .map((row) => ({
        ...articleRowToItem(articleRowForSelect(row, "list"), { includeSummaryJson: false, includeDetailFields: false }),
        viewCount: viewCountBySlug.get(String(row.slug)) ?? 0,
      }))
      .sort((left, right) => (order.get(left.slug) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.slug) ?? Number.MAX_SAFE_INTEGER))
      .slice(0, safeLimit);
  }

  async function listRelatedArticleIds(tagId: string, options: RelatedArticleIdsOptions): Promise<string[]> {
    const binding = requireCore(dependencies);
    const limit = options?.limit;
    if (!Number.isInteger(limit) || (limit as number) <= 0) {
      throw new D1ArticleShadowSkipError("unbounded", "listRelatedArticleIds");
    }
    if ((limit as number) > maxRows) {
      throw new D1ArticleShadowSkipError("limit_exceeds_max_rows", "listRelatedArticleIds");
    }
    const rows = await read(binding, "article_tags", {
      select: ["article_id"],
      where: [
        { column: "tag_id", value: tagId },
        { column: "article_id", op: "neq", value: options.excludeArticleId ?? "" },
      ],
      limit: (limit as number) + 1,
    });
    if (rows.length > (limit as number)) {
      throw new D1ArticleShadowSkipError("ambiguous_limit", "listRelatedArticleIds");
    }
    return uniqueStrings(rows.map((row) => row.article_id));
  }

  return {
    listArticles,
    listPublicSitemapArticles,
    listTopViewedArticles,
    listRelatedArticleIds,
    getArticleBySelect,
    getArticleSourceTextBySlug,
  };
}
