import { headers } from "next/headers";
import { FilterBar } from "@/components/filter-bar";
import { InfiniteArticleFeed } from "@/components/infinite-article-feed";
import { PageShell } from "@/components/ui/page-shell";
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
    <PageShell>
      <div className="mb-6">
        <FilterBar activeRange={filters.range ?? "latest"} sources={sources} tags={tags} params={params} />
      </div>

      <InfiniteArticleFeed initialResult={articles} queryString={params.toString()} pageSize={10} />
    </PageShell>
  );
}
