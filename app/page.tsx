import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import { Suspense } from "react";
import { ArrowRight, CalendarDays, Landmark } from "lucide-react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { IssueTopicCarousel } from "@/components/issue-topic-carousel";
import { PageViewTracker } from "@/components/page-view-tracker";
import { RecentDecisionMark } from "@/components/recent-decision-mark";
import { PageShell } from "@/components/ui/page-shell";
import { PUBLIC_ARTICLES_CACHE_TAG, PUBLIC_TAGS_CACHE_TAG } from "@/lib/public-content-cache";
import { listArticles, listSources, listTags } from "@/lib/db/queries";
import type { ArticleListItem, TagType } from "@/lib/db/types";
import { articleHrefWithReturnTo } from "@/lib/navigation/article-return";
import { formattedArticleDate } from "@/lib/ui/article-date-label";
import { displayArticleTypeLabel } from "@/lib/ui/content-type-labels";
import { compareHomeCountries } from "@/lib/ui/home-country-order";
import { displayJurisdictionFlag, displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";
import { JUDICIAL_COMPLAINT_TAG_SLUG } from "@/lib/tags/judicial-complaint";
import { getAppBaseUrl } from "@/lib/seo/metadata";

export const revalidate = 60;

export const metadata: Metadata = {
  alternates: { canonical: `${getAppBaseUrl()}/` },
};

const CONSTITUTIONAL_ISSUE_TYPES = new Set<TagType>(["right", "topic", "doctrine", "procedure"]);

const getHomePortalData = unstable_cache(
  async () => {
    const [sources, tags] = await Promise.all([
      listSources(),
      listTags({ sort: "count", limit: 120 }),
    ]);
    const jurisdictions = Array.from(
      new Set(sources.filter((source) => source.isActive).map((source) => source.jurisdiction)),
    ).sort(compareHomeCountries);
    const countryResults = await Promise.all(
      jurisdictions.map((jurisdiction) =>
        listArticles({ jurisdiction, page: 1, pageSize: 1, count: "none", includeViewCounts: false }),
      ),
    );
    const latestArticles = countryResults.flatMap((result) => result.items.slice(0, 1));

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
  ["home-country-portal-v3"],
  { revalidate: 60, tags: [PUBLIC_ARTICLES_CACHE_TAG, PUBLIC_TAGS_CACHE_TAG] },
);

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-sm bg-archive-skeleton ${className}`} />;
}

function HomeSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">국가별 최신 판례를 불러오는 중입니다.</span>
      <div className="mb-8 border-b border-archive-line-strong pb-7">
        <SkeletonBlock className="h-4 w-28" />
        <SkeletonBlock className="mt-3 h-12 w-80 max-w-full" />
        <SkeletonBlock className="mt-4 h-5 w-[36rem] max-w-full" />
      </div>
      <div className="mb-8 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => <SkeletonBlock key={index} className="h-28" />)}
      </div>
      <SkeletonBlock className="mb-8 h-64 sm:h-72" />
      <div className="border border-archive-line bg-white">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="grid min-h-24 grid-cols-[5rem_minmax(0,1fr)] gap-4 border-b border-archive-line p-4 last:border-b-0">
            <SkeletonBlock className="h-14 w-14" />
            <div className="space-y-2"><SkeletonBlock className="h-4 w-36" /><SkeletonBlock className="h-5 w-10/12" /><SkeletonBlock className="h-4 w-7/12" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function articleHref(article: ArticleListItem) {
  return articleHrefWithReturnTo(article.slug, "/");
}

function LeadDecision({ article }: { article: ArticleListItem }) {
  const title = article.koreanTitle || article.originalTitle || "제목 미상";
  const summary = article.oneLineSummary || "요약 준비 중입니다.";
  return (
    <section className="relative mb-8 min-h-[270px] overflow-hidden border-y border-archive-line bg-archive-surface-soft px-6 py-7 sm:px-8 lg:pr-[34%]" aria-labelledby="lead-decision">
      <div className="relative z-10 max-w-3xl">
        <p className="archive-kicker">최근 주요 판례</p>
        <p className="mt-4 text-sm font-semibold text-archive-text">{displaySourceLabel(article.sourceKey)} · {displayArticleTypeLabel(article)}</p>
        <h2 id="lead-decision" className="archive-serif mt-2 break-keep text-3xl font-semibold leading-tight text-archive-ink sm:text-4xl">{title}</h2>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-archive-text"><span className="inline-flex items-center gap-1.5"><CalendarDays className="size-3.5" aria-hidden="true" />{formattedArticleDate(article)}</span><span>{displayJurisdictionLabel(article.jurisdiction)}</span></div>
        <p className="mt-3 line-clamp-2 text-sm leading-7 text-archive-text">{summary}</p>
        <IntentPrefetchLink href={articleHref(article)} className="focus-ring mt-4 inline-flex items-center gap-2 rounded-sm border-b border-archive-accent pb-1 text-sm font-semibold text-archive-accent hover:text-archive-accent-hover">자세히 보기<ArrowRight className="size-4" aria-hidden="true" /></IntentPrefetchLink>
      </div>
      <Landmark className="pointer-events-none absolute -bottom-10 -right-10 size-[280px] stroke-[0.65] text-archive-subtle/25 sm:size-[350px] lg:right-2 lg:size-[400px]" aria-hidden="true" />
    </section>
  );
}

function CountryArticleMobile({ article }: { article: ArticleListItem }) {
  const title = article.koreanTitle || article.originalTitle || "제목 미상";
  return (
    <IntentPrefetchLink href={articleHref(article)} className="focus-ring block border-b border-archive-line p-4 last:border-b-0 hover:bg-archive-surface-soft xl:hidden">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-archive-heading"><span className="text-2xl" aria-hidden="true">{displayJurisdictionFlag(article.jurisdiction)}</span>{displayJurisdictionLabel(article.jurisdiction)}</p>
        <span className="text-xs text-archive-muted">{formattedArticleDate(article)}</span>
      </div>
      <h3 className="archive-serif mt-3 text-lg font-semibold leading-7 text-archive-heading">{title}<RecentDecisionMark publishedAt={article.originalPublishedAt} /></h3>
      <p className="mt-2 line-clamp-2 text-sm leading-6 text-archive-text">{article.oneLineSummary || "요약 준비 중입니다."}</p>
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-archive-muted"><span>{displaySourceLabel(article.sourceKey)} · {displayArticleTypeLabel(article)}</span><ArrowRight className="size-4 text-archive-accent" aria-hidden="true" /></div>
    </IntentPrefetchLink>
  );
}

function CountryArticleRow({ article }: { article: ArticleListItem }) {
  const title = article.koreanTitle || article.originalTitle || "제목 미상";
  const primaryTag = article.tags[0]?.name ?? "-";
  return (
    <IntentPrefetchLink href={articleHref(article)} className="focus-ring hidden min-h-[76px] grid-cols-[100px_110px_170px_90px_minmax(260px,1fr)_150px] items-center gap-3 border-b border-archive-line px-4 py-3 text-sm last:border-b-0 hover:bg-archive-surface-soft xl:grid">
      <span className="tabular-nums text-archive-text">{formattedArticleDate(article)}</span>
      <span className="flex items-center gap-2 font-semibold text-archive-heading"><span className="text-xl" aria-hidden="true">{displayJurisdictionFlag(article.jurisdiction)}</span>{displayJurisdictionLabel(article.jurisdiction)}</span>
      <span className="truncate text-archive-text">{displaySourceLabel(article.sourceKey)}</span>
      <span className="text-archive-text">{displayArticleTypeLabel(article)}</span>
      <span className="archive-serif line-clamp-2 font-semibold leading-6 text-archive-heading">{title}<RecentDecisionMark publishedAt={article.originalPublishedAt} /></span>
      <span className="flex items-center justify-between gap-2 text-xs text-archive-muted"><span className="truncate">{primaryTag}</span><ArrowRight className="size-4 shrink-0 text-archive-accent" aria-hidden="true" /></span>
    </IntentPrefetchLink>
  );
}

function CountryLatestPortal({ articles }: { articles: ArticleListItem[] }) {
  return (
    <section aria-labelledby="country-latest">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <h2 id="country-latest" className="archive-serif text-2xl font-semibold text-archive-ink">국가별 최신 판례</h2>
        <IntentPrefetchLink href="/list" className="focus-ring inline-flex items-center gap-2 rounded-sm text-sm font-semibold text-archive-accent hover:text-archive-accent-hover">전체 판례 보기<ArrowRight className="size-4" aria-hidden="true" /></IntentPrefetchLink>
      </div>
      <div className="overflow-hidden rounded-sm border border-archive-line bg-white">
        <div className="hidden grid-cols-[100px_110px_170px_90px_minmax(260px,1fr)_150px] gap-3 border-b border-archive-line-strong bg-archive-surface px-4 py-2.5 text-xs font-semibold text-archive-text xl:grid"><span>날짜</span><span>국가</span><span>기관</span><span>유형</span><span>제목</span><span>주제</span></div>
        {articles.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-archive-muted">공개된 최신 판례가 없습니다.</p>
        ) : articles.map((article) => (
          <div key={article.slug}><CountryArticleMobile article={article} /><CountryArticleRow article={article} /></div>
        ))}
      </div>
    </section>
  );
}

async function HomeContent() {
  const { issueTags, latestArticles } = await getHomePortalData();
  const leadArticle = [...latestArticles]
    .sort((left, right) => (right.originalPublishedAt || "").localeCompare(left.originalPublishedAt || ""))[0];
  return (
    <>
      <PageViewTracker event={{ eventType: "page_view", path: "/", resultCount: latestArticles.length, metadata: { surface: "country_latest_portal" } }} />
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
