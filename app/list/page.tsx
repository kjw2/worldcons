import { unstable_cache } from "next/cache";
import type { Metadata } from "next";
import { ArticleListView } from "@/components/article-list-view";
import { FilterBar } from "@/components/filter-bar";
import { PageViewTracker } from "@/components/page-view-tracker";
import { PageShell } from "@/components/ui/page-shell";
import { listArticles, listJurisdictionArticleCounts, listSources, listTags, listTopViewedArticles } from "@/lib/db/queries";
import type { ArticleListFilters, ArticleListResult } from "@/lib/db/types";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { articleFiltersFromSearchParams, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "리스트형 최신 자료",
  description: "세계 헌법재판기관의 최신 자료를 국가별 리스트와 페이지네이션으로 확인합니다.",
  alternates: { canonical: `${getAppBaseUrl()}/list` },
};

const getListFilterData = unstable_cache(
  async (range: ArticleListFilters["range"]) => {
    const sources = await listSources();
    const jurisdictions = Array.from(new Set(sources.map((source) => source.jurisdiction)));
    const [tags, jurisdictionArticleCounts] = await Promise.all([
      listTags({ sort: "count", limit: 30 }),
      listJurisdictionArticleCounts(jurisdictions, { range }),
    ]);

    return { sources, tags, jurisdictionArticleCounts };
  },
  ["list-filter-data-v1"],
  { revalidate: 300 },
);

const getListArticles = unstable_cache(
  async (filters: ArticleListFilters) => listArticles(filters),
  ["list-articles-v1"],
  { revalidate: 60 },
);

const getListTopViewedArticles = unstable_cache(
  async (filters: Pick<ArticleListFilters, "range" | "source" | "jurisdiction" | "type" | "language" | "tag">) =>
    listTopViewedArticles(5, filters),
  ["list-top-viewed-v1"],
  { revalidate: 300 },
);

function canUseJurisdictionTotal(filters: ArticleListFilters) {
  return !filters.q && !filters.source && !filters.type && !filters.tag && !filters.language;
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
  params.delete("page");
  params.delete("pageSize");
  params.delete("view");
  return params;
}

export default async function ArticleListPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const paramsObject = await resolveSearchParams(searchParams);
  const requestedFilters = articleFiltersFromSearchParams(paramsObject);
  const filters = { ...requestedFilters, page: requestedFilters.page ?? 1, pageSize: 10 };
  const countFromJurisdictions = canUseJurisdictionTotal(filters);
  const articleFilters = { ...filters, count: countFromJurisdictions ? ("none" as const) : ("exact" as const) };
  const params = paramsFromSearchParams(paramsObject);

  const [articleResult, { sources, tags, jurisdictionArticleCounts }, topViewedArticles] = await Promise.all([
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
  ]);
  const articles = countFromJurisdictions ? withJurisdictionTotal(articleResult, jurisdictionArticleCounts, filters) : articleResult;
  const paramsString = params.toString();

  return (
    <PageShell>
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
