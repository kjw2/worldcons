import { headers } from "next/headers";
import { FilterBar } from "@/components/filter-bar";
import { InfiniteArticleFeed } from "@/components/infinite-article-feed";
import { SearchBox } from "@/components/search-box";
import { recordSiteEvent } from "@/lib/analytics/events";
import { listArticles, listSources, listTags } from "@/lib/db/queries";
import { articleFiltersFromSearchParams, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function HomePage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const paramsObject = await resolveSearchParams(searchParams);
  const filters = { ...articleFiltersFromSearchParams(paramsObject), page: 1, pageSize: 10 };
  const params = new URLSearchParams();
  Object.entries(paramsObject).forEach(([key, value]) => {
    if (typeof value === "string" && value) params.set(key, value);
  });
  params.delete("page");
  params.delete("pageSize");

  const [articles, sources, tags] = await Promise.all([
    listArticles(filters),
    listSources(),
    listTags({ sort: "count" }),
  ]);
  await recordSiteEvent(
    {
      eventType: "page_view",
      path: "/",
      resultCount: articles.pageInfo.total,
      metadata: {
        source: filters.source,
        jurisdiction: filters.jurisdiction,
        tag: filters.tag,
        language: filters.language,
        type: filters.type,
        range: filters.range,
      },
    },
    await headers(),
  );

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 grid gap-5 lg:grid-cols-[1fr_360px] lg:items-end">
        <div>
          <p className="mb-2 text-sm font-semibold text-court">최신 소식</p>
          <h1 className="text-3xl font-semibold tracking-normal text-ink">공식 헌법재판 자료 한눈에 보기</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink/66">
            독일, 미국, 프랑스 헌법재판기관의 새 게시물을 수집하고 한국어 요약·태그로 정리합니다.
          </p>
        </div>
        <SearchBox defaultValue={filters.q} action="/" />
      </div>

      <div className="mb-6">
        <FilterBar activeRange={filters.range ?? "latest"} sources={sources} tags={tags} params={params} />
      </div>

      <InfiniteArticleFeed initialResult={articles} queryString={params.toString()} pageSize={10} />
    </main>
  );
}
