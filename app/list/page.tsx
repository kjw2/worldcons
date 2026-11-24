import { unstable_cache as plainUnstableCache } from "next/cache";
import { freshnessAwarePublicCache } from "@/lib/public-freshness-cache";
import type { Metadata } from "next";
import { ChevronRight } from "lucide-react";
import { ArticleListView } from "@/components/article-list-view";
import { FilterBar } from "@/components/filter-bar";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { PageViewTracker } from "@/components/page-view-tracker";
import { PageShell } from "@/components/ui/page-shell";
import { PUBLIC_ARTICLES_CACHE_TAG, PUBLIC_ARTICLE_COUNTS_CACHE_TAG, PUBLIC_TAGS_CACHE_TAG } from "@/lib/public-content-cache";
import { listArticles, listJurisdictionArticleCounts, listSources, listTags, listTopViewedArticles, publicArticleListCountMode } from "@/lib/db/queries";
import { runWithRequestLocalTagCandidates } from "@/lib/cloudflare/d1/request-local-tag-cache";
import type { ArticleListFilters, ArticleListResult } from "@/lib/db/types";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { publicListPaginationMetadata } from "@/lib/seo/list-pagination";
import { articleFiltersFromSearchParams, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const revalidate = 60;

export async function generateMetadata({ searchParams }: { searchParams?: Promise<SearchParams> }): Promise<Metadata> {
  const params = await resolveSearchParams(searchParams);
  return {
    title: "리스트형 최신 자료",
    description: "세계 헌법재판기관의 최신 자료를 국가별 리스트와 페이지네이션으로 확인합니다.",
    ...publicListPaginationMetadata(params, getAppBaseUrl()),
  };
}

// Filter metadata (sources/tags/jurisdiction counts) is not article content and
// carries no approval state. It must stay on a plain 300s cache even while E2E
// generation tables exist; otherwise every /list request reruns the full
// jurisdiction count (measured ~13k D1 rows per cold render).
const getListFilterData = plainUnstableCache(
  async (range: ArticleListFilters["range"]) => {
    const sources = await listSources();
    const jurisdictions = Array.from(new Set(sources.map((source) => source.jurisdiction)));
    const [tags, jurisdictionArticleCounts] = await Promise.all([
      listTags({ sort: "count", limit: 30 }),
      listJurisdictionArticleCounts(jurisdictions, { range }),
    ]);

    return { sources, tags, jurisdictionArticleCounts };
  },
  ["list-filter-data-v2"],
  { revalidate: 300, tags: [PUBLIC_ARTICLE_COUNTS_CACHE_TAG, PUBLIC_TAGS_CACHE_TAG] },
);

const getListArticles = freshnessAwarePublicCache(
  async (filters: ArticleListFilters) => listArticles(filters),
  ["list-articles-v2"],
  { revalidate: 60, tags: [PUBLIC_ARTICLES_CACHE_TAG] },
);

const getListTopViewedArticles = freshnessAwarePublicCache(
  async (filters: Pick<ArticleListFilters, "range" | "source" | "jurisdiction" | "type" | "language" | "tag">) =>
    listTopViewedArticles(5, filters),
  ["list-top-viewed-v2"],
  { revalidate: 300, tags: [PUBLIC_ARTICLES_CACHE_TAG] },
);

function canUseJurisdictionTotal(filters: ArticleListFilters) {
  return publicArticleListCountMode(filters) === "none";
}

function withJurisdictionTotal(articles: ArticleListResult, jurisdictionArticleCounts: Record<string, number>, filters: ArticleListFilters) {
  const total = Math.max(
    articles.items.length,
    filters.jurisdiction
      ? jurisdictionArticleCounts[filters.jurisdiction] ?? 0
      : Object.values(jurisdictionArticleCounts).reduce((sum, count) => sum + count, 0),
  );
  const shownThrough = (articles.pageInfo.page - 1) * articles.pageInfo.pageSize + articles.items.length;

  return {
    ...articles,
    pageInfo: {
      ...articles.pageInfo,
      total: Math.max(total, shownThrough),
      hasMore: shownThrough < total,
      totalIsExact: true,
    },
  };
}

function paramsFromSearchParams(paramsObject: SearchParams) {
  const params = new URLSearchParams();
  Object.entries(paramsObject).forEach(([key, value]) => {
    if (typeof value === "string" && value) params.set(key, value);
  });
  params.delete("pageSize");
  params.delete("view");
  return params;
}

export default async function ArticleListPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const paramsObject = await resolveSearchParams(searchParams);
  const requestedFilters = articleFiltersFromSearchParams(paramsObject);
  const filters = { ...requestedFilters, page: requestedFilters.page ?? 1, pageSize: 10 };
  const countFromJurisdictions = canUseJurisdictionTotal(filters);
  // The crawlable archive never asks D1 for a full exact count: even a narrow
  // filter stays on the bounded fast path and reports a conservative
  // lower-bound total. Exact counts remain available to explicit API callers.
  // The guard-batching switch is scoped to this surface only; every other
  // list caller keeps the existing global guard policy.
  const articleFilters = {
    ...filters,
    count: "none" as const,
    jsonGuardBatching: process.env.WORLDCONS_LIST_JSON_GUARD_BATCHING_ENABLED === "true",
  };
  const params = paramsFromSearchParams(paramsObject);

  const [articleResult, { sources, tags, jurisdictionArticleCounts }, topViewedArticles] = await runWithRequestLocalTagCandidates(() =>
    Promise.all([
      getListArticles(articleFilters),
      getListFilterData(filters.range),
      getListTopViewedArticles({
        range: filters.range,
        source: filters.source,
        jurisdiction: filters.jurisdiction,
        type: filters.type,
        language: filters.language,
        tag: filters.tag,
      }),
    ]),
  );
  const articles = countFromJurisdictions ? withJurisdictionTotal(articleResult, jurisdictionArticleCounts, filters) : articleResult;
  const paramsString = params.toString();

  return (
    <PageShell className="max-w-[1248px] py-6 sm:py-8">
      <PageViewTracker
        event={{
          eventType: "page_view",
          path: "/list",
          resultCount: articles.pageInfo.total,
          metadata: {
            source: filters.source,
            jurisdiction: filters.jurisdiction,
            tag: filters.tag,
            language: filters.language,
            type: filters.type,
            range: filters.range,
            view: "list",
          },
        }}
      />

      <header className="mb-7 border-b border-archive-line-strong pb-6">
        <nav className="mb-4 flex items-center gap-1.5 text-xs text-archive-muted" aria-label="현재 위치"><IntentPrefetchLink href="/" className="focus-ring rounded-sm hover:text-archive-accent">홈</IntentPrefetchLink><ChevronRight className="size-3" aria-hidden="true" /><span>전체 판례</span></nav>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="archive-serif text-2xl font-semibold leading-tight text-archive-ink sm:text-3xl">전체 판례</h1>
        </div>
      </header>

      <div className="mb-5">
        <FilterBar
          activeRange={filters.range ?? "latest"}
          sources={sources}
          tags={tags}
          paramsString={paramsString}
          jurisdictionArticleCounts={jurisdictionArticleCounts}
          basePath="/list"
          showJurisdictionChips={false}
        />
      </div>

      <ArticleListView
        result={articles}
        paramsString={paramsString}
        jurisdictionArticleCounts={jurisdictionArticleCounts}
        topViewedArticles={topViewedArticles}
      />
    </PageShell>
  );
}
