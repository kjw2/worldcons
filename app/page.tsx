import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import { Suspense } from "react";
import { ArrowRight } from "lucide-react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { PageViewTracker } from "@/components/page-view-tracker";
import { RecentDecisionMark } from "@/components/recent-decision-mark";
import { SearchBox } from "@/components/search-box";
import { PageShell } from "@/components/ui/page-shell";
import { PUBLIC_ARTICLES_CACHE_TAG, PUBLIC_TAGS_CACHE_TAG } from "@/lib/public-content-cache";
import { listArticles, listSources, listTags } from "@/lib/db/queries";
import type { ArticleListItem, TagType } from "@/lib/db/types";
import { articleHrefWithReturnTo } from "@/lib/navigation/article-return";
import { formattedArticleDate } from "@/lib/ui/article-date-label";
import { displayArticleTypeLabel } from "@/lib/ui/content-type-labels";
import { compareHomeCountries } from "@/lib/ui/home-country-order";
import { displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";
import { JUDICIAL_COMPLAINT_TAG_SLUG } from "@/lib/tags/judicial-complaint";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { articleCaseNumber } from "@/lib/ui/article-case-number";
import { articleTitleForDisplay } from "@/lib/ui/article-title";

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

    return {
      issueTags,
      latestArticles,
      activeSourceCount: sources.filter((source) => source.isActive).length,
      jurisdictionCount: jurisdictions.length,
    };
  },
  ["home-country-portal-v4"],
  { revalidate: 60, tags: [PUBLIC_ARTICLES_CACHE_TAG, PUBLIC_TAGS_CACHE_TAG] },
);

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-sm bg-archive-skeleton ${className}`} />;
}

function HomeSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-10">
      <span className="sr-only">홈페이지 정보를 불러오는 중입니다.</span>
      <div className="border-b border-archive-line-strong pb-8">
        <SkeletonBlock className="h-4 w-28" />
        <SkeletonBlock className="mt-4 h-10 w-80 max-w-full" />
        <SkeletonBlock className="mt-4 h-5 w-[34rem] max-w-full" />
        <SkeletonBlock className="mt-6 h-14 w-[48rem] max-w-full" />
      </div>
      <SkeletonBlock className="h-64" />
      <SkeletonBlock className="h-56" />
    </div>
  );
}

function articleHref(article: ArticleListItem) {
  return articleHrefWithReturnTo(article.slug, "/");
}

function LatestDecisionList({ articles }: { articles: ArticleListItem[] }) {
  const sorted = [...articles].sort((left, right) => (right.originalPublishedAt || "").localeCompare(left.originalPublishedAt || ""));

  return (
    <section aria-labelledby="latest-decisions" className="border-t-2 border-archive-accent">
      <div className="flex items-center justify-between gap-4 border-b border-archive-line-strong py-4">
        <h2 id="latest-decisions" className="text-xl font-bold text-archive-ink">최신 판례</h2>
        <IntentPrefetchLink href="/list" className="focus-ring inline-flex items-center gap-1 text-sm font-semibold text-archive-accent hover:text-archive-accent-hover">
          전체 판례 <ArrowRight className="size-4" aria-hidden="true" />
        </IntentPrefetchLink>
      </div>

      <div>
        {sorted.length === 0 ? (
          <p className="py-12 text-center text-sm text-archive-muted">공개된 최신 판례가 없습니다.</p>
        ) : sorted.map((article) => {
          const title = articleTitleForDisplay(article);
          const caseNumber = articleCaseNumber(article);
          return (
            <IntentPrefetchLink key={article.slug} href={articleHref(article)} className="focus-ring grid gap-2 border-b border-archive-line py-5 hover:bg-archive-surface-soft sm:grid-cols-[108px_150px_minmax(0,1fr)] sm:gap-4 sm:px-2">
              <span className="text-sm tabular-nums text-archive-muted">{formattedArticleDate(article)}</span>
              <span className="text-sm font-semibold text-archive-heading">{displayJurisdictionLabel(article.jurisdiction)}</span>
              <span className="min-w-0">
                <span className="block text-[17px] font-semibold leading-6 text-archive-heading">{title}{caseNumber ? <span className="ml-1 text-[0.72em] font-medium text-archive-muted">({caseNumber})</span> : null}<RecentDecisionMark publishedAt={article.originalPublishedAt} /></span>
                <span className="mt-1 block text-sm text-archive-muted">{displaySourceLabel(article.sourceKey)} · {displayArticleTypeLabel(article)}</span>
                {article.oneLineSummary ? <span className="mt-1 block line-clamp-1 text-sm leading-6 text-archive-text">{article.oneLineSummary}</span> : null}
              </span>
            </IntentPrefetchLink>
          );
        })}
      </div>
    </section>
  );
}

function IssueIndex({ tags }: { tags: Awaited<ReturnType<typeof getHomePortalData>>["issueTags"] }) {
  if (tags.length === 0) return null;

  return (
    <section aria-labelledby="issue-index" className="border-t-2 border-archive-accent">
      <div className="flex items-center justify-between gap-4 border-b border-archive-line-strong py-4">
        <h2 id="issue-index" className="text-xl font-bold text-archive-ink">주요 헌법 쟁점</h2>
        <IntentPrefetchLink href="/tags" className="focus-ring inline-flex items-center gap-1 text-sm font-semibold text-archive-accent hover:text-archive-accent-hover">전체 주제 <ArrowRight className="size-4" aria-hidden="true" /></IntentPrefetchLink>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3">
        {tags.map((tag) => (
          <IntentPrefetchLink key={tag.slug} href={`/list?tag=${encodeURIComponent(tag.slug)}`} className="focus-ring flex min-h-12 items-center justify-between gap-4 border-b border-archive-line px-1 py-3 text-sm hover:bg-archive-surface-soft sm:px-3">
            <span className="font-semibold text-archive-heading">{tag.name}</span>
            <span className="shrink-0 tabular-nums text-archive-muted">{(tag.articleCount ?? 0).toLocaleString("ko-KR")}</span>
          </IntentPrefetchLink>
        ))}
      </div>
    </section>
  );
}

async function HomeContent() {
  const { issueTags, latestArticles, activeSourceCount, jurisdictionCount } = await getHomePortalData();

  return (
    <>
      <PageViewTracker event={{ eventType: "page_view", path: "/", resultCount: latestArticles.length, metadata: { surface: "public_information_portal" } }} />

      <section className="border-b border-archive-line-strong pb-8 pt-2" aria-labelledby="home-title">
        <p className="text-sm font-bold text-archive-accent">WORLD CONS</p>
        <h1 id="home-title" className="mt-2 text-3xl font-extrabold tracking-[-0.035em] text-archive-ink sm:text-4xl">세계 헌법판례를 한 곳에서 찾습니다</h1>
        <p className="mt-3 max-w-3xl text-[15px] leading-7 text-archive-text">각국 헌법재판기관의 공개 판례와 결정례를 국가·기관·쟁점별로 검색하고 한국어 요약과 공식 원문을 함께 확인할 수 있습니다.</p>
        <div className="mt-6 max-w-4xl">
          <SearchBox variant="hero" placeholder="판례명, 사건번호, 헌법 쟁점을 검색하세요" />
        </div>
        <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm text-archive-muted">
          <span><strong className="font-bold text-archive-heading">{jurisdictionCount}</strong>개 국가</span>
          <span><strong className="font-bold text-archive-heading">{activeSourceCount}</strong>개 기관</span>
          <IntentPrefetchLink href="/sources" className="font-semibold text-archive-accent hover:text-archive-accent-hover">수록 기관 보기 →</IntentPrefetchLink>
        </div>
      </section>

      <div className="mt-10 space-y-12">
        <LatestDecisionList articles={latestArticles} />
        <IssueIndex tags={issueTags} />
      </div>
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
