import { D1_SHADOW_DEFAULT_MAX_ROWS } from "@/lib/cloudflare/d1/shadow/config";
import { runD1RuntimeRead, type D1RuntimeReadPredicate } from "@/lib/cloudflare/d1/runtime-read";
import { getRuntimeD1Binding, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import type { D1TableDefinition } from "@/lib/cloudflare/d1/types";
import { d1Schema } from "@/lib/cloudflare/d1/schema";
import { D1ShadowTruncatedError } from "@/lib/reference-reads/d1-repository";
import {
  boundedAdminArticlePage,
  boundedAdminArticlePageSize,
} from "@/lib/admin/ops-read-repository/shared";
import type {
  AdminOpsArticleListFilters,
  AdminOpsArticleListPage,
  AdminOpsArticleListRow,
  AdminOpsArticleRow,
  AdminOpsCandidateRow,
  AdminOpsCountTable,
} from "@/lib/admin/ops-read-repository/types";

/**
 * M6.4 D1-backed privileged admin/ops reads.
 *
 * This is the shadow reader for the four bounded `AdminOpsReadRepository`
 * methods that have a migrated D1 equivalent:
 *
 * - `loadArticleRows`        -> `worldcons_core.articles`
 * - `loadCandidateRows`      -> `worldcons_ingest.source_url_candidates`
 * - `countTableRows`         -> `worldcons_core.tags` / `worldcons_ingest.source_url_candidates`
 * - `listAdminArticles`      -> `worldcons_core.articles`
 *
 * `loadDashboardSnapshot` is an authoritative RPC with no migrated D1
 * equivalent; the wrapper never calls this adapter for it.
 *
 * The database binding is exact per method/table and can never be substituted:
 * `articles`/`tags` are `worldcons_core`, `source_url_candidates` is
 * `worldcons_ingest`. Every read is read-only and bounded (`maxRows + 1`): an
 * overflow raises the typed `D1ShadowTruncatedError` so the wrapper emits a skip
 * instead of comparing a partial result. `listAdminArticles` with a search query
 * is M7 and is skipped by the wrapper before any D1 call.
 */
export class D1AdminOpsShadowSkipError extends Error {
  readonly code = "d1_admin_ops_shadow.skip";
  readonly reason: string;
  readonly method: string;
  constructor(reason: string, method: string) {
    super(`D1 admin ops shadow skipped ${method}: ${reason}`);
    this.name = "D1AdminOpsShadowSkipError";
    this.reason = reason;
    this.method = method;
  }
}

export interface D1AdminOpsReadDependencies {
  /** The `worldcons_core` binding. Resolved from the runtime slot when omitted. */
  binding?: D1RuntimeDatabase | null;
  /** The `worldcons_ingest` binding. Resolved from the runtime slot when omitted. */
  ingestBinding?: D1RuntimeDatabase | null;
  /** Bounded shadow read limit. */
  maxRows?: number;
}

/** The exact authored select shape of the authoritative article row read. */
export const ADMIN_OPS_ARTICLE_ROW_COLUMNS = [
  "id",
  "slug",
  "source_key",
  "jurisdiction",
  "institution_name",
  "original_url",
  "original_title",
  "korean_title",
  "original_published_at",
  "fetched_at",
  "summarized_at",
  "status",
  "source_metadata",
  "error_metadata",
  "updated_at",
] as const;

/** The exact authored select shape of the authoritative candidate row read. */
export const ADMIN_OPS_CANDIDATE_ROW_COLUMNS = [
  "source_key",
  "status",
  "candidate_type",
  "created_at",
  "last_attempt_at",
] as const;

/** The BVerfG/admin list page bounds (shared with the authoritative adapter). */
const ADMIN_ARTICLE_LIST_SELECT_PREFIX = ADMIN_OPS_ARTICLE_ROW_COLUMNS.filter(
  (column) => column !== "error_metadata",
);

function tableByName(schema = d1Schema): Map<string, D1TableDefinition> {
  return new Map(schema.tables.map((table) => [table.name, table]));
}

function requireCore(dependencies: D1AdminOpsReadDependencies): D1RuntimeDatabase {
  const binding = dependencies.binding ?? getRuntimeD1Binding("worldcons_core");
  if (!binding) throw new Error("worldcons_core D1 binding is not available");
  return binding;
}

function requireIngest(dependencies: D1AdminOpsReadDependencies): D1RuntimeDatabase {
  const binding = dependencies.ingestBinding ?? getRuntimeD1Binding("worldcons_ingest");
  if (!binding) throw new Error("worldcons_ingest D1 binding is not available");
  return binding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The PostgREST `source_metadata->collection->>publishable` text comparison. */
function publishableText(row: { source_metadata?: unknown }): string | null {
  const collection = isRecord(row.source_metadata) ? row.source_metadata.collection : undefined;
  if (!isRecord(collection)) return null;
  const value = collection.publishable;
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Reproduces the authoritative `publishable` filters exactly as PostgREST
 * compares the projected JSON text (`...->>publishable`):
 *
 * - `yes` matches only the text `true` (JSON boolean `true` or string `"true"`);
 * - `no` matches a missing key (SQL NULL) or any text other than `true`.
 */
function matchesPublishableFilter(row: { source_metadata?: unknown }, filter: "all" | "yes" | "no"): boolean {
  if (filter === "all") return true;
  const text = publishableText(row);
  if (filter === "yes") return text === "true";
  return text === null || text !== "true";
}

/** Case-insensitive substring presence of every q term in the admin list haystack. */
function matchesAdminText(row: AdminOpsArticleListRow, q?: string): boolean {
  const normalized = q?.trim().toLowerCase();
  if (!normalized) return true;
  const terms = normalized.split(/\s+/).filter(Boolean);
  const haystack = [
    row.slug,
    row.korean_title,
    row.original_title,
    row.original_url,
    row.source_key,
    row.institution_name,
    row.jurisdiction,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function compareDescNullsLast(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? 1 : -1;
}

function adminListOrder(left: AdminOpsArticleListRow, right: AdminOpsArticleListRow): number {
  const byPublished = compareDescNullsLast(left.original_published_at ?? null, right.original_published_at ?? null);
  if (byPublished !== 0) return byPublished;
  const byUpdated = compareDescNullsLast(left.updated_at ?? null, right.updated_at ?? null);
  if (byUpdated !== 0) return byUpdated;
  if (left.id === right.id) return 0;
  return (left.id ?? "") < (right.id ?? "") ? -1 : 1;
}

export function createD1AdminOpsReadRepository(dependencies: D1AdminOpsReadDependencies = {}) {
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
      orderBy?: readonly string[];
      limit?: number;
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

  /** The authoritative article read selects these columns in this order. */
  function articleRowShape(row: Record<string, unknown>): AdminOpsArticleRow {
    return {
      id: row.id as string | undefined,
      slug: row.slug as string | undefined,
      source_key: row.source_key as string,
      jurisdiction: (row.jurisdiction as string | null | undefined) ?? null,
      institution_name: (row.institution_name as string | null | undefined) ?? null,
      original_url: (row.original_url as string | null | undefined) ?? null,
      original_title: (row.original_title as string | null | undefined) ?? null,
      korean_title: (row.korean_title as string | null | undefined) ?? null,
      original_published_at: (row.original_published_at as string | null | undefined) ?? null,
      fetched_at: (row.fetched_at as string | null | undefined) ?? null,
      summarized_at: (row.summarized_at as string | null | undefined) ?? null,
      status: row.status as string,
      source_metadata: isRecord(row.source_metadata) ? row.source_metadata : null,
      error_metadata: isRecord(row.error_metadata) ? row.error_metadata : null,
      updated_at: (row.updated_at as string | null | undefined) ?? null,
    };
  }

  function adminListRowShape(row: Record<string, unknown>): AdminOpsArticleListRow {
    return {
      id: row.id as string | undefined,
      slug: row.slug as string | undefined,
      source_key: row.source_key as string,
      jurisdiction: (row.jurisdiction as string | null | undefined) ?? null,
      institution_name: (row.institution_name as string | null | undefined) ?? null,
      original_url: (row.original_url as string | null | undefined) ?? null,
      original_title: (row.original_title as string | null | undefined) ?? null,
      korean_title: (row.korean_title as string | null | undefined) ?? null,
      original_published_at: (row.original_published_at as string | null | undefined) ?? null,
      fetched_at: (row.fetched_at as string | null | undefined) ?? null,
      summarized_at: (row.summarized_at as string | null | undefined) ?? null,
      status: row.status as string,
      source_metadata: isRecord(row.source_metadata) ? row.source_metadata : null,
      summary_json: row.summary_json ?? null,
      updated_at: (row.updated_at as string | null | undefined) ?? null,
    };
  }

  /**
   * Bounded, ordered read of `worldcons_core.articles` at `maxRows + 1`. The
   * authoritative read has no explicit SQL order and pages every row, so the
   * shadow uses the deterministic authored primary key `id asc` and the wrapper
   * compares the array unordered by `id`.
   */
  async function loadArticleRows(): Promise<AdminOpsArticleRow[]> {
    const rows = await read(requireCore(dependencies), "articles", {
      select: [...ADMIN_OPS_ARTICLE_ROW_COLUMNS],
      orderBy: ["id"],
      limit: maxRows + 1,
    });
    if (rows.length > maxRows) throw new D1ShadowTruncatedError("loadArticleRows");
    return rows.map(articleRowShape);
  }

  /** Bounded, ordered read of `worldcons_ingest.source_url_candidates` (unordered compare). */
  async function loadCandidateRows(): Promise<AdminOpsCandidateRow[]> {
    const rows = await read(requireIngest(dependencies), "source_url_candidates", {
      select: [...ADMIN_OPS_CANDIDATE_ROW_COLUMNS],
      orderBy: ["id"],
      limit: maxRows + 1,
    });
    if (rows.length > maxRows) throw new D1ShadowTruncatedError("loadCandidateRows");
    return rows.map((row) => ({
      source_key: row.source_key as string,
      status: row.status as string,
      candidate_type: (row.candidate_type as string | null | undefined) ?? null,
      created_at: (row.created_at as string | null | undefined) ?? null,
      last_attempt_at: (row.last_attempt_at as string | null | undefined) ?? null,
    }));
  }

  /**
   * Exact bounded count for a catalog table by reading only the authored primary
   * key column(s) at `maxRows + 1`. The authoritative exact count is honored only
   * when D1 proves the whole set fits within the bound; otherwise the wrapper
   * skips rather than reporting an approximate count.
   */
  async function countTableRows(table: AdminOpsCountTable): Promise<number> {
    if (table === "tags") {
      const rows = await read(requireCore(dependencies), "tags", { select: ["id"], orderBy: ["id"], limit: maxRows + 1 });
      if (rows.length > maxRows) throw new D1ShadowTruncatedError("countTableRows:tags");
      return rows.length;
    }
    const rows = await read(requireIngest(dependencies), "source_url_candidates", {
      select: ["id"],
      orderBy: ["id"],
      limit: maxRows + 1,
    });
    if (rows.length > maxRows) throw new D1ShadowTruncatedError("countTableRows:source_url_candidates");
    return rows.length;
  }

  /**
   * Bounded read + JS filtering/ordering/paging for the admin article list. The
   * full filtered set must be proven within `maxRows`; otherwise it skips rather
   * than report an approximate total. `q` is M7 and is rejected here (the wrapper
   * emits `search_deferred_m7` before any call), so this adapter never runs a
   * full-text search.
   */
  async function listAdminArticles(filters: AdminOpsArticleListFilters = {}): Promise<AdminOpsArticleListPage> {
    if (filters.q) throw new D1AdminOpsShadowSkipError("search_deferred_m7", "listAdminArticles");

    const page = boundedAdminArticlePage(filters.page);
    const pageSize = boundedAdminArticlePageSize(filters.pageSize);

    const where: D1RuntimeReadPredicate[] = [];
    if (filters.status) where.push({ column: "status", value: filters.status });
    if (filters.sourceKey) where.push({ column: "source_key", value: filters.sourceKey });
    if (filters.jurisdiction) where.push({ column: "jurisdiction", value: filters.jurisdiction });

    const select = [...ADMIN_ARTICLE_LIST_SELECT_PREFIX, "summary_json"];
    const rows = await read(requireCore(dependencies), "articles", { select, where, orderBy: ["id"], limit: maxRows + 1 });
    if (rows.length > maxRows) throw new D1ShadowTruncatedError("listAdminArticles");

    const shaped = rows.map(adminListRowShape);
    const publishable = filters.publishable ?? "all";
    const hasSummary = filters.hasSummary ?? "all";
    const matched = shaped
      .filter((row) => matchesAdminText(row, filters.q))
      .filter((row) => matchesPublishableFilter(row, publishable))
      .filter((row) => (hasSummary === "all" ? true : hasSummary === "yes" ? row.summary_json != null : row.summary_json == null))
      .sort(adminListOrder);

    const from = (page - 1) * pageSize;
    const pageRows = matched.slice(from, from + pageSize);
    return {
      rows: pageRows,
      pageInfo: {
        page,
        pageSize,
        total: matched.length,
        hasMore: from + pageRows.length < matched.length,
        totalIsExact: true,
      },
    };
  }

  return {
    loadArticleRows,
    loadCandidateRows,
    countTableRows,
    listAdminArticles,
  };
}

export type D1AdminOpsReadRepository = ReturnType<typeof createD1AdminOpsReadRepository>;
