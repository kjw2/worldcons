import { unstable_cache } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowRight, CalendarDays, Landmark } from "lucide-react";
import { IssueTopicCarousel } from "@/components/issue-topic-carousel";
import { PageViewTracker } from "@/components/page-view-tracker";
import { PageShell } from "@/components/ui/page-shell";
import { PUBLIC_ARTICLES_CACHE_TAG, PUBLIC_TAGS_CACHE_TAG } from "@/lib/public-content-cache";
import { listArticles, listSources, listTags } from "@/lib/db/queries";
import type { ArticleListItem, TagType } from "@/lib/db/types";
import { formattedArticleDate } from "@/lib/ui/article-date-label";
import { displayArticleTypeLabel } from "@/lib/ui/content-type-labels";
import { displayJurisdictionFlag, displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";
import { JUDICIAL_COMPLAINT_TAG_SLUG } from "@/lib/tags/judicial-complaint";

export const revalidate = 60;

const CONSTITUTIONAL_ISSUE_TYPES = new Set<TagType>(["right", "topic", "doctrine", "procedure"]);

const getHomePortalData = unstable_cache(
  async () => {
    const [sources, tags] = await Promise.all([
      listSources(),
      listTags({ sort: "count", limit: 120 }),
    ]);
    const jurisdictions = Array.from(
      new Set(sources.filter((source) => source.isActive).map((source) => source.jurisdiction)),
    );
    const countryResults = await Promise.all(
      jurisdictions.map((jurisdiction) =>
        listArticles({ jurisdiction, page: 1, pageSize: 1, count: "none", includeViewCounts: false }),
      ),
    );
    const latestArticles = countryResults
      .flatMap((result) => result.items.slice(0, 1))
      .sort((left, right) => (right.originalPublishedAt || "").localeCompare(left.originalPublishedAt || ""));

    const issueCandidates = tags.filter(
      (tag) => CONSTITUTIONAL_ISSUE_TYPES.has(tag.type) && (tag.articleCount ?? 0) > 0 && tag.latestArticleAt,
    );
    const maxCount = Math.max(1, ...issueCandidates.map((tag) => tag.articleCount ?? 0));
    const newestUpdate = Math.max(0, ...issueCandidates.map((tag) => Date.parse(tag.latestArticleAt ?? "") || 0));
    const oneYear = 365 * 24 * 60 * 60 * 1_000;
    const seenNames = new Set<string>();
    const rankedIssueTags = issueCandidates
      .sort((left, right) => {
        const score = (tag: (typeof issueCandidates)[number]) => {
          const popularity = Math.log1p(tag.articleCount ?? 0) / Math.log1p(maxCount);
          const updatedAt = Date.parse(tag.latestArticleAt ?? "") || 0;
          const recency = Math.max(0, 1 - (newestUpdate - updatedAt) / oneYear);
          return popularity * 0.7 + recency * 0.3;
        };
        return score(right) - score(left);
      })
      .filter((tag) => {
        const key = (tag.normalizedName || tag.name).trim().toLocaleLowerCase("ko-KR");
        if (seenNames.has(key)) return false;
        seenNames.add(key);
        return true;
      });
    const judicialComplaintTag = rankedIssueTags.find((tag) => tag.slug === JUDICIAL_COMPLAINT_TAG_SLUG);
    const issueTags = judicialComplaintTag
      ? [judicialComplaintTag, ...rankedIssueTags.filter((tag) => tag.slug !== JUDICIAL_COMPLAINT_TAG_SLUG)].slice(0, 12)
      : rankedIssueTags.slice(0, 12);

    return { issueTags, latestArticles };
  },
  ["home-country-portal-v2"],
  { revalidate: 60, tags: [PUBLIC_ARTICLES_CACHE_TAG, PUBLIC_TAGS_CACHE_TAG] },
);

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-sm bg-[#e7ebe8] ${className}`} />;
}

function HomeSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">국가별 최신 판례를 불러오는 중입니다.</span>
      <div className="mb-8 border-b border-[#b8c5be] pb-7">
        <SkeletonBlock className="h-4 w-28" />
        <SkeletonBlock className="mt-3 h-12 w-80 max-w-full" />
        <SkeletonBlock className="mt-4 h-5 w-[36rem] max-w-full" />
      </div>
      <div className="mb-8 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => <SkeletonBlock key={index} className="h-28" />)}
      </div>
      <SkeletonBlock className="mb-8 h-64 sm:h-72" />
      <div className="border border-[#d4dcd7] bg-white">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="grid min-h-24 grid-cols-[5rem_minmax(0,1fr)] gap-4 border-b border-[#e0e5e2] p-4 last:border-b-0">
            <SkeletonBlock className="h-14 w-14" />
            <div className="space-y-2"><SkeletonBlock className="h-4 w-36" /><SkeletonBlock className="h-5 w-10/12" /><SkeletonBlock className="h-4 w-7/12" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function articleHref(article: ArticleListItem) {
  return `/v2/articles/${article.slug}?${new URLSearchParams({ returnTo: "/v2" }).toString()}`;
}

function LeadDecision({ article }: { article: ArticleListItem }) {
  const title = article.koreanTitle || article.originalTitle || "제목 미상";
  const summary = article.oneLineSummary || "요약 준비 중입니다.";
  return (
    <section className="relative mb-8 min-h-[270px] overflow-hidden border-y border-[#c8d1cc] bg-[#f6f7f3] px-6 py-7 sm:px-8 lg:pr-[34%]" aria-labelledby="lead-decision">
      <div className="relative z-10 max-w-3xl">
        <p className="archive-kicker">오늘의 주요 결정</p>
        <p className="mt-4 text-sm font-semibold text-[#38574c]">{displaySourceLabel(article.sourceKey)} · {displayArticleTypeLabel(article)}</p>
        <h2 id="lead-decision" className="archive-serif mt-2 break-keep text-3xl font-semibold leading-tight text-[#123d32] sm:text-4xl">{title}</h2>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[#596862]"><span className="inline-flex items-center gap-1.5"><CalendarDays className="size-3.5" aria-hidden="true" />{formattedArticleDate(article)}</span><span>{displayJurisdictionLabel(article.jurisdiction)}</span></div>
        <p className="mt-3 line-clamp-2 text-sm leading-7 text-[#4f5f59]">{summary}</p>
        <Link href={articleHref(article)} prefetch={false} className="focus-ring mt-4 inline-flex items-center gap-2 rounded-sm border-b border-[#123d32] pb-1 text-sm font-semibold text-[#123d32] hover:text-[#2a6350]">자세히 보기<ArrowRight className="size-4" aria-hidden="true" /></Link>
      </div>
      <Landmark className="pointer-events-none absolute -bottom-10 -right-10 size-[280px] stroke-[0.65] text-[#8ea097]/25 sm:size-[350px] lg:right-2 lg:size-[400px]" aria-hidden="true" />
    </section>
  );
}

function CountryArticleMobile({ article }: { article: ArticleListItem }) {
  const title = article.koreanTitle || article.originalTitle || "제목 미상";
  return (
    <Link href={articleHref(article)} prefetch={false} className="focus-ring block border-b border-[#e0e5e2] p-4 last:border-b-0 hover:bg-[#f8faf8] xl:hidden">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-[#25483c]"><span className="text-2xl" aria-hidden="true">{displayJurisdictionFlag(article.jurisdiction)}</span>{displayJurisdictionLabel(article.jurisdiction)}</p>
        <span className="text-xs text-[#6a7772]">{formattedArticleDate(article)}</span>
      </div>
      <h3 className="archive-serif mt-3 text-lg font-semibold leading-7 text-[#173d33]">{title}</h3>
      <p className="mt-2 line-clamp-2 text-sm leading-6 text-[#5b6964]">{article.oneLineSummary || "요약 준비 중입니다."}</p>
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-[#74817c]"><span>{displaySourceLabel(article.sourceKey)} · {displayArticleTypeLabel(article)}</span><ArrowRight className="size-4 text-[#315b4d]" aria-hidden="true" /></div>
    </Link>
  );
}

function CountryArticleRow({ article }: { article: ArticleListItem }) {
  const title = article.koreanTitle || article.originalTitle || "제목 미상";
  const primaryTag = article.tags[0]?.name ?? "-";
  return (
    <Link href={articleHref(article)} prefetch={false} className="focus-ring hidden min-h-[76px] grid-cols-[100px_110px_170px_90px_minmax(260px,1fr)_150px] items-center gap-3 border-b border-[#e0e5e2] px-4 py-3 text-sm last:border-b-0 hover:bg-[#f8faf8] xl:grid">
      <span className="tabular-nums text-[#5f6c67]">{formattedArticleDate(article)}</span>
      <span className="flex items-center gap-2 font-semibold text-[#25483c]"><span className="text-xl" aria-hidden="true">{displayJurisdictionFlag(article.jurisdiction)}</span>{displayJurisdictionLabel(article.jurisdiction)}</span>
      <span className="truncate text-[#52615b]">{displaySourceLabel(article.sourceKey)}</span>
      <span className="text-[#52615b]">{displayArticleTypeLabel(article)}</span>
      <span className="archive-serif line-clamp-2 font-semibold leading-6 text-[#173d33]">{title}</span>
      <span className="flex items-center justify-between gap-2 text-xs text-[#65736d]"><span className="truncate">{primaryTag}</span><ArrowRight className="size-4 shrink-0 text-[#315b4d]" aria-hidden="true" /></span>
    </Link>
  );
}

function CountryLatestPortal({ articles }: { articles: ArticleListItem[] }) {
  return (
    <section aria-labelledby="country-latest">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div><p className="archive-kicker">Latest by country</p><h2 id="country-latest" className="archive-serif mt-1 text-2xl font-semibold text-[#123d32]">최신 판례</h2></div>
        <Link href="/v2/list" className="focus-ring inline-flex items-center gap-2 rounded-sm text-sm font-semibold text-[#345a4d] hover:text-[#123d32]">전체 판례 보기<ArrowRight className="size-4" aria-hidden="true" /></Link>
      </div>
      <div className="overflow-hidden rounded-sm border border-[#cbd5cf] bg-white">
        <div className="hidden grid-cols-[100px_110px_170px_90px_minmax(260px,1fr)_150px] gap-3 border-b border-[#b9c6be] bg-[#f4f6f3] px-4 py-2.5 text-xs font-semibold text-[#53635d] xl:grid"><span>날짜</span><span>국가</span><span>기관</span><span>유형</span><span>제목</span><span>주제</span></div>
        {articles.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-[#6a7772]">공개된 최신 판례가 없습니다.</p>
        ) : articles.map((article) => (
          <div key={article.slug}><CountryArticleMobile article={article} /><CountryArticleRow article={article} /></div>
        ))}
      </div>
    </section>
  );
}

async function HomeContent() {
  const { issueTags, latestArticles } = await getHomePortalData();
  const leadArticle = latestArticles[0];
  return (
    <>
      <PageViewTracker event={{ eventType: "page_view", path: "/v2", resultCount: latestArticles.length, metadata: { surface: "country_latest_portal" } }} />
      <h1 className="sr-only">최신 헌법 판례</h1>
      <IssueTopicCarousel tags={issueTags} />
      {leadArticle ? <LeadDecision article={leadArticle} /> : null}
      <CountryLatestPortal articles={latestArticles} />
    </>
  );
}

export default function HomePage() {
  return (
    <PageShell className="public-archive-page max-w-[1248px] py-6 sm:py-8">
      <Suspense fallback={<HomeSkeleton />}><HomeContent /></Suspense>
    </PageShell>
  );
}
