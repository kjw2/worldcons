import { CalendarDays, ChevronLeft, ChevronRight, Eye } from "lucide-react";
import { ArticleListReturnState } from "@/components/article-list-return-state";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { RecentDecisionMark } from "@/components/recent-decision-mark";
import { SurfaceCard } from "@/components/ui/surface-card";
import type { ArticleListItem, ArticleListResult } from "@/lib/db/types";
import { articleHrefWithReturnTo } from "@/lib/navigation/article-return";
import { formattedArticleDate } from "@/lib/ui/article-date-label";
import { displayJurisdictionFlag, displayJurisdictionLabel } from "@/lib/ui/source-labels";
import { cn } from "@/lib/utils/classnames";

const COUNTRY_FILTERS: Array<{ label: string; jurisdiction?: string }> = [
  { label: "전체" },
  { label: "미국", jurisdiction: "United States" },
  { label: "독일", jurisdiction: "Germany" },
  { label: "프랑스", jurisdiction: "France" },
  { label: "스페인", jurisdiction: "Spain" },
];

function formatNumber(value?: number) {
  return new Intl.NumberFormat("ko-KR").format(Math.max(0, Math.floor(value ?? 0)));
}

function baseParams(paramsString: string) {
  const params = new URLSearchParams(paramsString);
  params.delete("page");
  params.delete("pageSize");
  params.delete("view");
  return params;
}

function hrefWithParams(params: URLSearchParams) {
  const query = params.toString();
  return query ? `/v2/list?${query}` : "/v2/list";
}

function hrefForJurisdiction(paramsString: string, jurisdiction?: string) {
  const params = baseParams(paramsString);
  if (jurisdiction) params.set("jurisdiction", jurisdiction);
  else params.delete("jurisdiction");
  return hrefWithParams(params);
}

function hrefForPage(paramsString: string, page: number) {
  const params = baseParams(paramsString);
  if (page > 1) params.set("page", String(page));
  return hrefWithParams(params);
}

function currentListReturnPath(paramsString: string) {
  return paramsString ? `/v2/list?${paramsString}` : "/v2/list";
}

function hrefForArticle(slug: string, paramsString: string) {
  return articleHrefWithReturnTo(slug, currentListReturnPath(paramsString));
}

function totalForCountries(counts: Record<string, number>) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function paginationItems(currentPage: number, totalPages: number) {
  const pages = new Set<number>([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
  const validPages = [...pages].filter((page) => page >= 1 && page <= totalPages).sort((left, right) => left - right);
  const items: Array<number | "ellipsis"> = [];

  validPages.forEach((page, index) => {
    const previous = validPages[index - 1];
    if (previous && page - previous > 1) items.push("ellipsis");
    items.push(page);
  });

  return items;
}

function ListArticleRow({ article, paramsString }: { article: ArticleListItem; paramsString: string }) {
  const title = article.koreanTitle || article.originalTitle || "제목 미상";
  const summary = article.oneLineSummary || article.summaryJson?.summary.coreSummary[0] || "요약 준비 중입니다.";

  return (
    <article data-article-slug={article.slug} className="border-b border-archive-line last:border-b-0 hover:bg-archive-surface-soft">
      <div className="px-4 py-4 xl:hidden">
        <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-archive-muted"><span>{displayJurisdictionFlag(article.jurisdiction)} {displayJurisdictionLabel(article.jurisdiction)}</span></div>
        <h2 className="archive-serif line-clamp-2 text-[17px] font-semibold leading-7 text-archive-heading"><IntentPrefetchLink href={hrefForArticle(article.slug, paramsString)} data-list-article-slug={article.slug} className="focus-ring rounded-sm hover:text-archive-accent-hover">{title}<RecentDecisionMark publishedAt={article.originalPublishedAt} /></IntentPrefetchLink></h2>
        <p className="mt-1 line-clamp-2 text-sm leading-6 text-archive-text">{summary}</p>
        <div className="mt-2 flex items-center gap-3 text-xs text-archive-subtle"><span className="inline-flex items-center gap-1"><CalendarDays className="size-3.5" aria-hidden="true" />{formattedArticleDate(article)}</span><span className="inline-flex items-center gap-1"><Eye className="size-3.5" aria-hidden="true" />{formatNumber(article.viewCount)}</span></div>
      </div>
      <div className="hidden min-h-[74px] grid-cols-[94px_100px_minmax(280px,1fr)_140px] items-center gap-3 px-4 py-3 text-sm xl:grid">
        <span className="text-xs tabular-nums text-archive-muted">{formattedArticleDate(article)}</span>
        <span className="text-xs font-semibold text-archive-heading">{displayJurisdictionFlag(article.jurisdiction)} {displayJurisdictionLabel(article.jurisdiction)}</span>
        <div className="min-w-0"><IntentPrefetchLink href={hrefForArticle(article.slug, paramsString)} data-list-article-slug={article.slug} className="focus-ring archive-serif line-clamp-2 rounded-sm font-semibold leading-6 text-archive-heading hover:text-archive-accent-hover">{title}<RecentDecisionMark publishedAt={article.originalPublishedAt} /></IntentPrefetchLink><p className="mt-0.5 line-clamp-1 text-xs text-archive-muted">{summary}</p></div>
        <div className="min-w-0 text-xs text-archive-muted">{article.tags.slice(0, 2).map((tag) => <IntentPrefetchLink key={tag.slug} href={`/v2/tags/${tag.slug}`} className="focus-ring mr-2 inline-block max-w-full truncate rounded-sm hover:text-archive-accent">{tag.name}</IntentPrefetchLink>)}<span className="mt-1 flex items-center gap-1 text-archive-subtle"><Eye className="size-3" aria-hidden="true" />{formatNumber(article.viewCount)}</span></div>
      </div>
    </article>
  );
}

function CountryMenu({
  currentJurisdiction,
  counts,
  paramsString,
}: {
  currentJurisdiction?: string;
  counts: Record<string, number>;
  paramsString: string;
}) {
  return (
    <SurfaceCard className="overflow-hidden p-4">
      <h2 className="archive-rule-title text-sm font-semibold text-archive-heading">국가별 판례</h2>
      <nav className="mt-2 grid gap-1" aria-label="국가 필터">
        {COUNTRY_FILTERS.map((item) => {
          const isActive = item.jurisdiction ? currentJurisdiction === item.jurisdiction : !currentJurisdiction;
          const count = item.jurisdiction ? counts[item.jurisdiction] ?? 0 : totalForCountries(counts);

          return (
            <IntentPrefetchLink
              key={item.jurisdiction ?? "all"}
              href={hrefForJurisdiction(paramsString, item.jurisdiction)}
              className={cn(
                "focus-ring flex min-h-10 items-center justify-between gap-3 rounded-sm border-b border-archive-line px-2 text-sm font-semibold transition last:border-b-0",
                isActive ? "bg-archive-tint text-archive-accent" : "text-archive-text hover:bg-archive-surface hover:text-archive-accent",
              )}
            >
              <span>{item.label}</span>
              <span className="text-xs tabular-nums text-archive-subtle">
                {formatNumber(count)}
              </span>
            </IntentPrefetchLink>
          );
        })}
      </nav>
    </SurfaceCard>
  );
}

function ListPagination({ result, paramsString }: { result: ArticleListResult; paramsString: string }) {
  const { page, pageSize, total } = result.pageInfo;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const items = paginationItems(page, totalPages);
  const hasPrevious = page > 1;
  const hasNext = page < totalPages;

  return (
    <nav className="flex flex-wrap items-center justify-center gap-1 border-t border-archive-line px-4 py-5" aria-label="페이지">
      <IntentPrefetchLink
        href={hrefForPage(paramsString, page - 1)}
        aria-disabled={!hasPrevious}
        className={cn(
          "focus-ring inline-flex min-h-9 items-center gap-1 rounded-sm border border-archive-line px-3 text-sm font-semibold",
          hasPrevious ? "bg-white text-archive-text hover:border-archive-accent hover:text-archive-accent" : "pointer-events-none bg-archive-surface text-archive-subtle",
        )}
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        이전
      </IntentPrefetchLink>
      {items.map((item, index) =>
        item === "ellipsis" ? (
          <span key={`ellipsis-${index}`} className="px-2 text-sm text-ink-subtle">
            ...
          </span>
        ) : (
          <IntentPrefetchLink
            key={item}
            href={hrefForPage(paramsString, item)}
            aria-current={item === page ? "page" : undefined}
            className={cn(
              "focus-ring inline-flex size-9 items-center justify-center rounded-sm border text-sm font-semibold tabular-nums",
              item === page ? "border-archive-accent bg-archive-accent text-white" : "border-archive-line bg-white text-archive-text hover:border-archive-accent hover:text-archive-accent",
            )}
          >
            {item}
          </IntentPrefetchLink>
        ),
      )}
      <IntentPrefetchLink
        href={hrefForPage(paramsString, page + 1)}
        aria-disabled={!hasNext}
        className={cn(
          "focus-ring inline-flex min-h-9 items-center gap-1 rounded-sm border border-archive-line px-3 text-sm font-semibold",
          hasNext ? "bg-white text-archive-text hover:border-archive-accent hover:text-archive-accent" : "pointer-events-none bg-archive-surface text-archive-subtle",
        )}
      >
        다음
        <ChevronRight className="size-4" aria-hidden="true" />
      </IntentPrefetchLink>
    </nav>
  );
}

function TopViewedList({ articles, paramsString }: { articles: ArticleListItem[]; paramsString: string }) {
  return (
    <SurfaceCard className="overflow-hidden p-4">
      <h2 className="archive-rule-title text-sm font-semibold text-archive-heading">조회수 상위 자료</h2>
      <ol className="mt-3 space-y-3">
        {articles.length === 0 ? (
          <li className="text-sm leading-6 text-ink-muted">조회수 데이터가 아직 없습니다.</li>
        ) : (
          articles.slice(0, 5).map((article, index) => (
            <li key={article.slug} className="flex gap-2">
              <span className="archive-serif mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-sm font-semibold text-archive-accent">
                {index + 1}
              </span>
              <div className="min-w-0">
                <IntentPrefetchLink href={hrefForArticle(article.slug, paramsString)} data-list-article-slug={article.slug} className="focus-ring archive-serif line-clamp-2 rounded-sm text-sm font-semibold leading-5 text-archive-heading hover:text-archive-accent">
                  {article.koreanTitle || article.originalTitle || "제목 미상"}
                  <RecentDecisionMark publishedAt={article.originalPublishedAt} />
                </IntentPrefetchLink>
                <p className="mt-1 inline-flex items-center gap-1 text-xs text-ink-subtle">
                  <Eye className="size-3.5" aria-hidden="true" />
                  {formatNumber(article.viewCount)}
                </p>
              </div>
            </li>
          ))
        )}
      </ol>
    </SurfaceCard>
  );
}

export function ArticleListView({
  result,
  paramsString,
  jurisdictionArticleCounts,
  topViewedArticles,
}: {
  result: ArticleListResult;
  paramsString: string;
  jurisdictionArticleCounts: Record<string, number>;
  topViewedArticles: ArticleListItem[];
}) {
  const currentJurisdiction = new URLSearchParams(paramsString).get("jurisdiction") ?? undefined;
  const { page, pageSize, total } = result.pageInfo;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, (page - 1) * pageSize + result.items.length);

  return (
    <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]" aria-label="리스트형 자료 목록">
      <ArticleListReturnState />
      <SurfaceCard className="min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-archive-line-strong px-4 py-3 sm:px-5">
          <h2 className="text-base font-semibold text-archive-heading">판례 목록</h2>
          <p className="text-sm text-archive-muted">
            총 {formatNumber(total)}건 · {formatNumber(from)}-{formatNumber(to)} 표시
          </p>
        </div>

        <div className="hidden grid-cols-[94px_100px_minmax(280px,1fr)_140px] gap-3 border-b border-archive-line bg-archive-surface px-4 py-2.5 text-xs font-semibold text-archive-text xl:grid"><span>날짜</span><span>국가</span><span>제목</span><span>주제 / 조회</span></div>

        {result.items.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-ink-muted">조건에 맞는 자료가 없습니다.</div>
        ) : (
          result.items.map((article) => <ListArticleRow key={article.slug} article={article} paramsString={paramsString} />)
        )}

        <ListPagination result={result} paramsString={paramsString} />
      </SurfaceCard>

      <aside className="space-y-4 lg:sticky lg:top-[calc(var(--chrome-header-height)+1rem)] lg:self-start"><CountryMenu currentJurisdiction={currentJurisdiction} counts={jurisdictionArticleCounts} paramsString={paramsString} /><TopViewedList articles={topViewedArticles} paramsString={paramsString} /></aside>
    </section>
  );
}
