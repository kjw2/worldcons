import { unstable_cache } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowRight, CalendarDays, Landmark, MessageSquareText, Scale, ShieldCheck, Vote } from "lucide-react";
import { FilterBar } from "@/components/filter-bar";
import { InfiniteArticleFeed } from "@/components/infinite-article-feed";
import { PageViewTracker } from "@/components/page-view-tracker";
import { PageShell } from "@/components/ui/page-shell";
import { PUBLIC_ARTICLES_CACHE_TAG, PUBLIC_ARTICLE_COUNTS_CACHE_TAG, PUBLIC_TAGS_CACHE_TAG } from "@/lib/public-content-cache";
import { listArticles, listJurisdictionArticleCounts, listSources, listTags } from "@/lib/db/queries";
import type { ArticleListFilters, ArticleListItem, ArticleListResult, SourceRecord, TagSummary } from "@/lib/db/types";
import { formattedArticleDate } from "@/lib/ui/article-date-label";
import { displayArticleTypeLabel } from "@/lib/ui/content-type-labels";
import { displayJurisdictionFlag, displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";
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
  ["home-filter-data-v3"],
  { revalidate: 300, tags: [PUBLIC_ARTICLE_COUNTS_CACHE_TAG, PUBLIC_TAGS_CACHE_TAG] },
);

const getHomeArticles = unstable_cache(
  async (filters: ArticleListFilters) => listArticles(filters),
  ["home-articles-v3"],
  { revalidate: 60, tags: [PUBLIC_ARTICLES_CACHE_TAG] },
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
      <div className="mb-8 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => <SkeletonBlock key={index} className="h-28 rounded-sm" />)}
      </div>
      <SkeletonBlock className="mb-8 h-72 rounded-sm" />
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

const issueIcons = [MessageSquareText, Vote, ShieldCheck, Scale] as const;

function IssueTrackers({ tags }: { tags: TagSummary[] }) {
  const featuredTags = tags.slice(0, 4);
  if (featuredTags.length === 0) return null;

  return (
    <section className="mb-8" aria-labelledby="issue-trackers">
      <h2 id="issue-trackers" className="archive-rule-title mb-3 text-base font-semibold text-[#243b33]">주요 헌법 쟁점</h2>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {featuredTags.map((tag, index) => {
          const Icon = issueIcons[index % issueIcons.length];
          return (
            <Link key={tag.slug} href={`/tags/${tag.slug}`} prefetch={false} className="focus-ring group grid min-h-28 grid-cols-[42px_minmax(0,1fr)_auto] gap-3 rounded-sm border border-[#d4dcd7] bg-white p-4 transition hover:border-[#829b8e] hover:bg-[#f8faf8]">
              <span className="inline-flex size-10 items-center justify-center text-[#315b4d]"><Icon className="size-6" aria-hidden="true" /></span>
              <span className="min-w-0"><span className="archive-serif block break-words text-lg font-semibold text-[#173d33]">{tag.name}</span><span className="mt-2 block text-xs text-[#68756f]">관련 판례 {(tag.articleCount ?? 0).toLocaleString("ko-KR")}건</span></span>
              <ArrowRight className="mt-auto size-4 text-[#7c8983] transition group-hover:translate-x-0.5 group-hover:text-[#123d32]" aria-hidden="true" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function articleHref(article: ArticleListItem, paramsString: string) {
  const returnTo = paramsString ? `/?${paramsString}` : "/";
  return `/articles/${article.slug}?${new URLSearchParams({ returnTo }).toString()}`;
}

function LeadDecision({ article, paramsString }: { article: ArticleListItem; paramsString: string }) {
  const title = article.koreanTitle || article.originalTitle || "제목 미상";
  const summary = article.oneLineSummary || article.summaryJson?.summary.coreSummary[0] || "요약 준비 중입니다.";

  return (
    <section className="relative mb-8 min-h-[300px] overflow-hidden rounded-sm border-y border-[#c8d1cc] bg-[#f6f7f3] px-6 py-7 sm:px-8 sm:py-9 lg:pr-[34%]" aria-labelledby="lead-decision">
      <div className="relative z-10 max-w-4xl">
        <p className="archive-kicker">오늘의 주요 결정</p>
        <p className="mt-5 text-sm font-semibold text-[#38574c]">{displaySourceLabel(article.sourceKey)} · {displayArticleTypeLabel(article)}</p>
        <h1 id="lead-decision" className="archive-serif mt-3 break-keep text-3xl font-semibold leading-tight text-[#123d32] sm:text-4xl lg:text-[42px]">{title}</h1>
        <div className="mt-5 flex flex-wrap items-center gap-3 text-xs text-[#596862]"><span className="inline-flex items-center gap-1.5"><CalendarDays className="size-3.5" aria-hidden="true" />{formattedArticleDate(article)}</span><span>{displayJurisdictionLabel(article.jurisdiction)}</span></div>
        <p className="mt-4 line-clamp-3 max-w-3xl text-sm leading-7 text-[#4f5f59] sm:text-base">{summary}</p>
        <Link href={articleHref(article, paramsString)} prefetch={false} className="focus-ring mt-5 inline-flex items-center gap-2 rounded-sm border-b border-[#123d32] pb-1 text-sm font-semibold text-[#123d32] hover:text-[#2a6350]">자세히 보기<ArrowRight className="size-4" aria-hidden="true" /></Link>
      </div>
      <Landmark className="pointer-events-none absolute -bottom-10 -right-10 size-[280px] stroke-[0.7] text-[#8ea097]/25 sm:size-[360px] lg:right-4 lg:size-[420px]" aria-hidden="true" />
    </section>
  );
}

function countryHref(jurisdiction: string, paramsString: string) {
  const params = new URLSearchParams(paramsString);
  params.set("jurisdiction", jurisdiction);
  params.delete("source");
  params.delete("page");
  return `/?${params.toString()}`;
}

function CountryShortcuts({ sources, counts, paramsString }: { sources: SourceRecord[]; counts: Record<string, number>; paramsString: string }) {
  return (
    <section className="mb-10" aria-labelledby="country-shortcuts">
      <h2 id="country-shortcuts" className="archive-rule-title mb-3 text-base font-semibold text-[#243b33]">국가별 바로가기</h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {sources.map((source) => (
          <Link key={source.sourceKey} href={countryHref(source.jurisdiction, paramsString)} prefetch={false} className="focus-ring flex min-h-20 items-center gap-4 rounded-sm border border-[#d4dcd7] bg-white px-4 transition hover:border-[#879d92] hover:bg-[#f8faf8]">
            <span className="text-3xl" aria-hidden="true">{displayJurisdictionFlag(source.jurisdiction)}</span>
            <span><span className="archive-serif block text-lg font-semibold text-[#173d33]">{displayJurisdictionLabel(source.jurisdiction)}</span><span className="mt-1 block text-xs text-[#6a7772]">{(counts[source.jurisdiction] ?? 0).toLocaleString("ko-KR")}건</span></span>
          </Link>
        ))}
      </div>
    </section>
  );
}

async function HomeContent({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const paramsObject = await resolveSearchParams(searchParams);
  const baseFilters = { ...articleFiltersFromSearchParams(paramsObject), page: 1, pageSize: 9 };
  const countFromJurisdictions = canUseJurisdictionTotal(baseFilters);
  const filters = { ...baseFilters, count: countFromJurisdictions ? ("none" as const) : ("exact" as const) };
  const params = new URLSearchParams();
  Object.entries(paramsObject).forEach(([key, value]) => {
    if (typeof value === "string" && value) params.set(key, value);
  });
  params.delete("page");
  params.delete("pageSize");
  params.delete("view");

  const [articleResult, { sources, tags, jurisdictionArticleCounts }] = await Promise.all([
    getHomeArticles(filters),
    getHomeFilterData(filters.range),
  ]);
  const articles = countFromJurisdictions ? withJurisdictionTotal(articleResult, jurisdictionArticleCounts, filters) : articleResult;
  const leadArticle = articles.items[0];
  const feedArticles = leadArticle ? { ...articles, items: articles.items.slice(1) } : articles;
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
      <IssueTrackers tags={tags} />
      {leadArticle ? <LeadDecision article={leadArticle} paramsString={params.toString()} /> : null}
      <CountryShortcuts sources={sources} counts={jurisdictionArticleCounts} paramsString={params.toString()} />
      <section aria-labelledby="latest-decisions">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div><p className="archive-kicker">Archive</p><h2 id="latest-decisions" className="archive-serif mt-1 text-3xl font-semibold text-[#123d32]">최신 판례</h2></div>
          <Link href="/list" className="focus-ring inline-flex items-center gap-2 rounded-sm text-sm font-semibold text-[#345a4d] hover:text-[#123d32]">전체 목록<ArrowRight className="size-4" aria-hidden="true" /></Link>
        </div>
      <div className="mb-6">
        <FilterBar
          activeRange={filters.range ?? "latest"}
          sources={sources}
          tags={tags}
          paramsString={params.toString()}
          jurisdictionArticleCounts={jurisdictionArticleCounts}
        />
      </div>
      <InfiniteArticleFeed initialResult={feedArticles} queryString={params.toString()} pageSize={9} leadingItemCount={leadArticle ? 1 : 0} />
      </section>
    </>
  );
}

export default function HomePage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  return (
    <PageShell className="public-archive-page">
      <Suspense fallback={<HomeSkeleton />}>
        <HomeContent searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
