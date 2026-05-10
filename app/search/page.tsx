import { FilterBar } from "@/components/filter-bar";
import { InfiniteArticleFeed } from "@/components/infinite-article-feed";
import { SearchBox } from "@/components/search-box";
import { listArticles, listSources, listTags } from "@/lib/db/queries";
import { hybridSearch, semanticSearch } from "@/lib/search/vector";
import { articleFiltersFromSearchParams, getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SearchPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const paramsObject = await resolveSearchParams(searchParams);
  const filters = { ...articleFiltersFromSearchParams(paramsObject), page: 1, pageSize: 10 };
  const modeParam = getSearchParam(paramsObject, "mode");
  const mode = modeParam === "fulltext" || modeParam === "semantic" || modeParam === "hybrid" ? modeParam : "hybrid";
  const params = new URLSearchParams();
  Object.entries(paramsObject).forEach(([key, value]) => {
    if (typeof value === "string" && value) params.set(key, value);
  });
  params.delete("page");
  params.delete("pageSize");

  const [articles, sources, tags] = await Promise.all([
    mode === "semantic" ? semanticSearch(filters) : mode === "hybrid" ? hybridSearch(filters) : listArticles(filters),
    listSources(),
    listTags({ sort: "count" }),
  ]);
  const q = getSearchParam(paramsObject, "q");
  const modeHiddenParams = [...params.entries()].filter(([key]) => key !== "q" && key !== "mode" && key !== "page");

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <p className="mb-2 text-sm font-semibold text-court">통합 검색</p>
        <h1 className="text-3xl font-semibold tracking-normal text-ink">제목·요약·원문·태그 검색</h1>
      </div>
      <div className="mb-5">
        <SearchBox defaultValue={q} action="/search" />
      </div>
      <form action="/search" className="mb-5 flex flex-wrap items-center gap-3 rounded-md border border-rule bg-white p-3 text-sm shadow-sm">
        <input type="hidden" name="q" value={q ?? ""} />
        {modeHiddenParams.map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
        <span className="font-medium text-ink/64">검색 방식</span>
        <select name="mode" defaultValue={mode} className="focus-ring h-9 rounded-md border border-rule bg-white px-3">
          <option value="hybrid">Hybrid</option>
          <option value="fulltext">Full-text</option>
          <option value="semantic">Semantic</option>
        </select>
        <button type="submit" className="focus-ring rounded-md bg-ink px-3 py-2 font-semibold text-white">
          적용
        </button>
      </form>
      <div className="mb-6">
        <FilterBar activeRange={filters.range ?? "latest"} sources={sources} tags={tags} params={params} basePath="/search" />
      </div>
      <InfiniteArticleFeed initialResult={articles} endpoint="/api/search" queryString={params.toString()} pageSize={10} />
    </main>
  );
}
