import { unstable_cache } from "next/cache";
import { FilterBar } from "@/components/filter-bar";
import { InfiniteArticleFeed } from "@/components/infinite-article-feed";
import { PageViewTracker } from "@/components/page-view-tracker";
import { PageShell } from "@/components/ui/page-shell";
import { listArticles, listSources, listTags } from "@/lib/db/queries";
import type { ArticleListFilters } from "@/lib/db/types";
import { articleFiltersFromSearchParams, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const getHomeFilterData = unstable_cache(
  async () => Promise.all([listSources(), listTags({ sort: "count", limit: 30 })]),
  ["home-filter-data-v1"],
  { revalidate: 300 },
);

const getHomeArticles = unstable_cache(
  async (filters: ArticleListFilters) => listArticles(filters),
  ["home-articles-v1"],
  { revalidate: 60 },
);

export default async function HomePage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const paramsObject = await resolveSearchParams(searchParams);
  const filters = { ...articleFiltersFromSearchParams(paramsObject), page: 1, pageSize: 10, count: "exact" as const };
  const params = new URLSearchParams();
  Object.entries(paramsObject).forEach(([key, value]) => {
    if (typeof value === "string" && value) params.set(key, value);
  });
  params.delete("page");
  params.delete("pageSize");

  const [articles, [sources, tags]] = await Promise.all([
    getHomeArticles(filters),
    getHomeFilterData(),
  ]);
  const pageViewEvent = {
    eventType: "page_view" as const,
    path: "/",
    resultCount: articles.pageInfo.total,
    metadata: {
      source: filters.source,
      jurisdiction: filters.jurisdiction,
      tag: filters.tag,
      language: filters.language,
      type: filters.type,
      range: filters.range,
      totalIsExact: articles.pageInfo.totalIsExact,
    },
  };

  return (
    <PageShell>
      <PageViewTracker event={pageViewEvent} />
      <div className="mb-6">
        <FilterBar activeRange={filters.range ?? "latest"} sources={sources} tags={tags} params={params} />
      </div>

      <InfiniteArticleFeed initialResult={articles} queryString={params.toString()} pageSize={10} />
    </PageShell>
  );
}
