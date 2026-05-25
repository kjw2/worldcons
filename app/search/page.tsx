import { headers } from "next/headers";
import Link from "next/link";
import { FilterBar } from "@/components/filter-bar";
import { InfiniteArticleFeed } from "@/components/infinite-article-feed";
import { chipClassName } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { PageShell } from "@/components/ui/page-shell";
import { SectionHeading } from "@/components/ui/section-heading";
import { SurfaceCard } from "@/components/ui/surface-card";
import { recordSearchEvent, recordSiteEvent } from "@/lib/analytics/events";
import { listArticles, listGlossaryTerms, listSources, listTags } from "@/lib/db/queries";
import { glossarySourceLanguageLabel } from "@/lib/glossary/languages";
import { hybridSearch, semanticSearch } from "@/lib/search/vector";
import { articleFiltersFromSearchParams, getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const modeOptions = [
  { value: "hybrid", label: "혼합 검색" },
  { value: "fulltext", label: "정확히 찾기" },
  { value: "semantic", label: "의미로 찾기" },
] as const;

const typeLabels: Record<string, string> = {
  news: "뉴스",
  press_release: "보도자료",
  decision: "결정",
  opinion: "의견",
  order: "명령",
  other: "기타",
};

const recommendedQueries = ["표현의 자유", "선거", "평등권", "QPC", "First Amendment", "비례원칙"];

function matchingGlossaryTerms(terms: Awaited<ReturnType<typeof listGlossaryTerms>>, q?: string) {
  if (!q) return [];
  const needles = q.toLowerCase().split(/\s+/).map((item) => item.trim()).filter(Boolean);
  if (needles.length === 0) return [];
  return terms
    .filter((term) => {
      const haystack = [term.term, term.koreanTerm, term.definition, term.jurisdiction, ...term.relatedTags].filter(Boolean).join(" ").toLowerCase();
      return needles.every((needle) => haystack.includes(needle));
    })
    .slice(0, 6);
}

function hrefWithParam(params: URLSearchParams, key: string, value?: string) {
  const next = new URLSearchParams(params);
  if (value) next.set(key, value);
  else next.delete(key);
  next.delete("page");
  const query = next.toString();
  return query ? `/search?${query}` : "/search";
}

function hrefWithoutParam(params: URLSearchParams, key: string) {
  return hrefWithParam(params, key);
}

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

  const [articles, sources, tags, glossaryTerms] = await Promise.all([
    mode === "semantic" ? semanticSearch(filters) : mode === "hybrid" ? hybridSearch(filters) : listArticles(filters),
    listSources(),
    listTags({ sort: "count" }),
    listGlossaryTerms(),
  ]);
  const q = getSearchParam(paramsObject, "q");
  const relatedTerms = matchingGlossaryTerms(glossaryTerms, q);
  const headerStore = await headers();
  await recordSiteEvent(
    {
      eventType: "page_view",
      path: "/search",
      resultCount: articles.pageInfo.total,
      metadata: {
        q,
        mode,
        source: filters.source,
        jurisdiction: filters.jurisdiction,
        tag: filters.tag,
        language: filters.language,
        type: filters.type,
      },
    },
    headerStore,
  );
  await recordSearchEvent({
    query: q,
    mode,
    resultCount: articles.pageInfo.total,
    headers: headerStore,
    metadata: {
      source: filters.source,
      jurisdiction: filters.jurisdiction,
      tag: filters.tag,
      language: filters.language,
      type: filters.type,
    },
  });
  const sourceMap = new Map(sources.map((source) => [source.sourceKey, source.name]));
  const tagMap = new Map(tags.map((tag) => [tag.slug, tag.name]));
  const activeFilterChips = [
    q ? { key: "q", label: `검색어: ${q}` } : null,
    filters.jurisdiction ? { key: "jurisdiction", label: `국가: ${filters.jurisdiction}` } : null,
    filters.source ? { key: "source", label: `기관: ${sourceMap.get(filters.source) ?? filters.source}` } : null,
    filters.type ? { key: "type", label: `유형: ${typeLabels[filters.type] ?? filters.type}` } : null,
    filters.tag ? { key: "tag", label: `태그: ${tagMap.get(filters.tag) ?? filters.tag}` } : null,
    filters.language ? { key: "language", label: `언어: ${filters.language}` } : null,
    mode !== "hybrid" ? { key: "mode", label: `검색 방식: ${modeOptions.find((option) => option.value === mode)?.label ?? mode}` } : null,
  ].filter(Boolean) as Array<{ key: string; label: string }>;

  return (
    <PageShell>
      <SectionHeading
        className="mb-6"
        eyebrow="통합 검색"
        title="제목·요약·원문·태그 검색"
        description="정확한 문구부터 의미가 가까운 쟁점까지 공식 헌법재판 자료 안에서 탐색합니다."
      />
      <div className="mb-5">
        <FilterBar activeRange={filters.range ?? "latest"} sources={sources} tags={tags} params={params} basePath="/search" />
      </div>

      <SurfaceCard className="mb-5 space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-sm font-semibold text-ink-muted">검색 방식</span>
          {modeOptions.map((option) => (
            <Link
              key={option.value}
              href={hrefWithParam(params, "mode", option.value)}
              className={chipClassName(mode === option.value ? "selected" : "default")}
            >
              {option.label}
            </Link>
          ))}
        </div>
        {!q ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <span className="mr-1 text-sm font-semibold text-ink-muted">추천 검색어</span>
            {recommendedQueries.map((query) => (
              <Link key={query} href={hrefWithParam(params, "q", query)} className={chipClassName("muted")}>
                {query}
              </Link>
            ))}
          </div>
        ) : null}
        {activeFilterChips.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <span className="mr-1 text-sm font-semibold text-ink-muted">현재 조건</span>
            {activeFilterChips.map((chip) => (
              <Link key={chip.key} href={hrefWithoutParam(params, chip.key)} className={chipClassName("muted")}>
                {chip.label} ×
              </Link>
            ))}
          </div>
        ) : null}
      </SurfaceCard>

      {relatedTerms.length > 0 ? (
        <SurfaceCard className="mb-5 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-ink">관련 용어</h2>
            <Link href={`/glossary?q=${encodeURIComponent(q ?? "")}`} className="focus-ring rounded-md text-sm font-semibold text-primary hover:text-court">
              용어사전에서 보기
            </Link>
          </div>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {relatedTerms.map((term) => (
              <Link key={term.slug} href={`/glossary/${term.slug}`} className="focus-ring rounded-lg border border-line bg-white p-3 transition hover:border-line-strong hover:bg-surface-muted/45">
                <span className="line-clamp-1 text-sm font-semibold text-ink">{term.koreanTerm || term.term}</span>
                <span className="mt-1 block text-xs text-ink-subtle">출처 언어: {glossarySourceLanguageLabel(term)}</span>
              </Link>
            ))}
          </div>
        </SurfaceCard>
      ) : null}

      {articles.pageInfo.total === 0 ? (
        <EmptyState
          title="검색 결과가 없습니다"
          description="검색어를 조금 넓히거나 필터를 초기화하면 더 많은 공식 자료와 용어를 찾을 수 있습니다."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link href="/search" className={chipClassName("selected")}>
                필터 초기화
              </Link>
              {q ? (
                <Link href={`/glossary?q=${encodeURIComponent(q)}`} className={chipClassName("default")}>
                  용어사전 검색
                </Link>
              ) : null}
              {recommendedQueries.slice(0, 4).map((query) => (
                <Link key={query} href={hrefWithParam(params, "q", query)} className={chipClassName("default")}>
                  {query}
                </Link>
              ))}
            </div>
          }
        />
      ) : (
        <InfiniteArticleFeed initialResult={articles} endpoint="/api/search" queryString={params.toString()} pageSize={10} />
      )}
    </PageShell>
  );
}
