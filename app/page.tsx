import { unstable_cache } from "next/cache";
import { Suspense } from "react";
import { FilterBar } from "@/components/filter-bar";
import { InfiniteArticleFeed } from "@/components/infinite-article-feed";
import { PageViewTracker } from "@/components/page-view-tracker";
import { PageShell } from "@/components/ui/page-shell";
import { listArticles, listJurisdictionArticleCounts, listSources, listTags } from "@/lib/db/queries";
import type { ArticleListFilters } from "@/lib/db/types";
import { articleFiltersFromSearchParams, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const revalidate = 60;

const getHomeFilterData = unstable_cache(
  async (range: ArticleListFilters["range"]) => {
    const sources = await listSources();
    const jurisdictions = Array.from(new Set(sources.map((source) => source.jurisdiction)));
    const [tags, jurisdictionArticleCounts] = await Promise.all([
      listTags({ sort: "count", limit: 30 }),
      listJurisdictionArticleCounts(jurisdictions, { range }),
    ]);

    return { sources, tags, jurisdictionArticleCounts };
  },
  ["home-filter-data-v2"],
  { revalidate: 300 },
);

const getHomeArticles = unstable_cache(
  async (filters: ArticleListFilters) => listArticles(filters),
  ["home-articles-v1"],
  { revalidate: 60 },
);

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-surface-muted ${className}`} />;
}

function FilterBarSkeleton() {
  return (
    <div className="rounded-lg border border-line bg-white p-4 shadow-sm">
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <SkeletonBlock key={`range-${index}`} className="h-10 w-20 rounded-lg" />
        ))}
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <SkeletonBlock className="h-11 rounded-lg" />
        <SkeletonBlock className="h-11 rounded-lg" />
        <SkeletonBlock className="h-11 rounded-lg" />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {Array.from({ length: 8 }).map((_, index) => (
          <SkeletonBlock key={`tag-${index}`} className="h-8 w-24 rounded-full" />
        ))}
      </div>
    </div>
  );
}

function ArticleCardSkeleton() {
  return (
    <div className="flex min-h-[17rem] flex-col rounded-lg border border-line bg-white p-4 shadow-sm">
      <div className="mb-3 flex gap-2">
        <SkeletonBlock className="h-6 w-20 rounded-full" />
        <SkeletonBlock className="h-6 w-14 rounded-full" />
      </div>
      <div className="space-y-2">
        <SkeletonBlock className="h-5 w-11/12" />
        <SkeletonBlock className="h-5 w-8/12" />
      </div>
      <div className="mt-4 space-y-2">
        <SkeletonBlock className="h-4 w-full" />
        <SkeletonBlock className="h-4 w-10/12" />
        <SkeletonBlock className="h-4 w-7/12" />
      </div>
      <div className="mt-4 flex gap-2">
        <SkeletonBlock className="h-6 w-16 rounded-full" />
        <SkeletonBlock className="h-6 w-20 rounded-full" />
      </div>
      <div className="grow" />
      <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
        <SkeletonBlock className="h-4 w-24" />
        <div className="flex gap-2">
          <SkeletonBlock className="h-8 w-14 rounded-md" />
          <SkeletonBlock className="size-8 rounded-md" />
          <SkeletonBlock className="size-8 rounded-md" />
        </div>
      </div>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">최신 자료를 불러오는 중입니다.</span>
      <div className="mb-6">
        <FilterBarSkeleton />
      </div>
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SkeletonBlock className="h-5 w-24" />
          <SkeletonBlock className="h-5 w-20" />
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 9 }).map((_, index) => (
            <ArticleCardSkeleton key={index} />
          ))}
        </div>
      </section>
    </div>
  );
}

async function HomeContent({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const paramsObject = await resolveSearchParams(searchParams);
  const filters = { ...articleFiltersFromSearchParams(paramsObject), page: 1, pageSize: 9, count: "estimated" as const };
  const params = new URLSearchParams();
  Object.entries(paramsObject).forEach(([key, value]) => {
    if (typeof value === "string" && value) params.set(key, value);
  });
  params.delete("page");
  params.delete("pageSize");

  const [articles, { sources, tags, jurisdictionArticleCounts }] = await Promise.all([
    getHomeArticles(filters),
    getHomeFilterData(filters.range),
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
    <>
      <PageViewTracker event={pageViewEvent} />
      <div className="mb-6">
        <FilterBar
          activeRange={filters.range ?? "latest"}
          sources={sources}
          tags={tags}
          params={params}
          jurisdictionArticleCounts={jurisdictionArticleCounts}
        />
      </div>

      <InfiniteArticleFeed initialResult={articles} queryString={params.toString()} pageSize={9} />
    </>
  );
}

export default function HomePage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  return (
    <PageShell>
      <Suspense fallback={<HomeSkeleton />}>
        <HomeContent searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
