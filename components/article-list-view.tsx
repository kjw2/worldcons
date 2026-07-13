import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight, Eye } from "lucide-react";
import { SurfaceCard } from "@/components/ui/surface-card";
import type { ArticleListItem, ArticleListResult } from "@/lib/db/types";
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
  return query ? `/list?${query}` : "/list";
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
  return paramsString ? `/list?${paramsString}` : "/list";
}

function hrefForArticle(slug: string, paramsString: string) {
  const params = new URLSearchParams({ returnTo: currentListReturnPath(paramsString) });
  return `/articles/${slug}?${params.toString()}`;
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
    <article data-article-slug={article.slug} className="border-b border-[#dce2de] last:border-b-0 hover:bg-[#f8faf8]">
      <div className="px-4 py-4 xl:hidden">
        <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-[#74817c]"><span>{displayJurisdictionFlag(article.jurisdiction)} {displayJurisdictionLabel(article.jurisdiction)}</span></div>
        <h2 className="archive-serif line-clamp-2 text-[17px] font-semibold leading-7 text-[#173d33]"><Link href={hrefForArticle(article.slug, paramsString)} prefetch={false} className="focus-ring rounded-sm hover:text-[#2e6552]">{title}</Link></h2>
        <p className="mt-1 line-clamp-2 text-sm leading-6 text-[#5f6c67]">{summary}</p>
        <div className="mt-2 flex items-center gap-3 text-xs text-[#7a8681]"><span className="inline-flex items-center gap-1"><CalendarDays className="size-3.5" aria-hidden="true" />{formattedArticleDate(article)}</span><span className="inline-flex items-center gap-1"><Eye className="size-3.5" aria-hidden="true" />{formatNumber(article.viewCount)}</span></div>
      </div>
      <div className="hidden min-h-[74px] grid-cols-[94px_100px_minmax(280px,1fr)_140px] items-center gap-3 px-4 py-3 text-sm xl:grid">
        <span className="text-xs tabular-nums text-[#67746f]">{formattedArticleDate(article)}</span>
        <span className="text-xs font-semibold text-[#334d44]">{displayJurisdictionFlag(article.jurisdiction)} {displayJurisdictionLabel(article.jurisdiction)}</span>
        <div className="min-w-0"><Link href={hrefForArticle(article.slug, paramsString)} prefetch={false} className="focus-ring archive-serif line-clamp-2 rounded-sm font-semibold leading-6 text-[#173d33] hover:text-[#2e6552]">{title}</Link><p className="mt-0.5 line-clamp-1 text-xs text-[#73807b]">{summary}</p></div>
        <div className="min-w-0 text-xs text-[#6e7b76]">{article.tags.slice(0, 2).map((tag) => <Link key={tag.slug} href={`/tags/${tag.slug}`} prefetch={false} className="focus-ring mr-2 inline-block max-w-full truncate rounded-sm hover:text-[#123d32]">{tag.name}</Link>)}<span className="mt-1 flex items-center gap-1 text-[#8a9691]"><Eye className="size-3" aria-hidden="true" />{formatNumber(article.viewCount)}</span></div>
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
      <h2 className="archive-rule-title text-sm font-semibold text-[#243b33]">국가별 판례</h2>
      <nav className="mt-2 grid gap-1" aria-label="국가 필터">
        {COUNTRY_FILTERS.map((item) => {
          const isActive = item.jurisdiction ? currentJurisdiction === item.jurisdiction : !currentJurisdiction;
          const count = item.jurisdiction ? counts[item.jurisdiction] ?? 0 : totalForCountries(counts);

          return (
            <Link
              key={item.jurisdiction ?? "all"}
              href={hrefForJurisdiction(paramsString, item.jurisdiction)}
              prefetch={false}
              className={cn(
                "focus-ring flex min-h-10 items-center justify-between gap-3 rounded-sm border-b border-[#e1e6e2] px-2 text-sm font-semibold transition last:border-b-0",
                isActive ? "bg-[#edf3ef] text-[#123d32]" : "text-[#5f6d68] hover:bg-[#f5f7f4] hover:text-[#123d32]",
              )}
            >
              <span>{item.label}</span>
              <span className="text-xs tabular-nums text-[#82908a]">
                {formatNumber(count)}
              </span>
            </Link>
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
    <nav className="flex flex-wrap items-center justify-center gap-1 border-t border-[#cbd4ce] px-4 py-5" aria-label="페이지">
      <Link
        href={hrefForPage(paramsString, page - 1)}
        prefetch={false}
        aria-disabled={!hasPrevious}
        className={cn(
          "focus-ring inline-flex min-h-9 items-center gap-1 rounded-sm border border-[#d1d9d4] px-3 text-sm font-semibold",
          hasPrevious ? "bg-white text-[#5e6d67] hover:border-[#8ca095] hover:text-[#123d32]" : "pointer-events-none bg-[#f4f6f3] text-[#a0aaa5]",
        )}
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        이전
      </Link>
      {items.map((item, index) =>
        item === "ellipsis" ? (
          <span key={`ellipsis-${index}`} className="px-2 text-sm text-ink-subtle">
            ...
          </span>
        ) : (
          <Link
            key={item}
            href={hrefForPage(paramsString, item)}
            prefetch={false}
            aria-current={item === page ? "page" : undefined}
            className={cn(
              "focus-ring inline-flex size-9 items-center justify-center rounded-sm border text-sm font-semibold tabular-nums",
              item === page ? "border-[#123d32] bg-[#123d32] text-white" : "border-[#d1d9d4] bg-white text-[#5e6d67] hover:border-[#8ca095] hover:text-[#123d32]",
            )}
          >
            {item}
          </Link>
        ),
      )}
      <Link
        href={hrefForPage(paramsString, page + 1)}
        prefetch={false}
        aria-disabled={!hasNext}
        className={cn(
          "focus-ring inline-flex min-h-9 items-center gap-1 rounded-sm border border-[#d1d9d4] px-3 text-sm font-semibold",
          hasNext ? "bg-white text-[#5e6d67] hover:border-[#8ca095] hover:text-[#123d32]" : "pointer-events-none bg-[#f4f6f3] text-[#a0aaa5]",
        )}
      >
        다음
        <ChevronRight className="size-4" aria-hidden="true" />
      </Link>
    </nav>
  );
}

function TopViewedList({ articles, paramsString }: { articles: ArticleListItem[]; paramsString: string }) {
  return (
    <SurfaceCard className="overflow-hidden p-4">
      <h2 className="archive-rule-title text-sm font-semibold text-[#243b33]">조회수 상위 자료</h2>
      <ol className="mt-3 space-y-3">
        {articles.length === 0 ? (
          <li className="text-sm leading-6 text-ink-muted">조회수 데이터가 아직 없습니다.</li>
        ) : (
          articles.slice(0, 5).map((article, index) => (
            <li key={article.slug} className="flex gap-2">
              <span className="archive-serif mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-sm font-semibold text-[#315b4d]">
                {index + 1}
              </span>
              <div className="min-w-0">
                <Link href={hrefForArticle(article.slug, paramsString)} prefetch={false} className="focus-ring archive-serif line-clamp-2 rounded-sm text-sm font-semibold leading-5 text-[#273f37] hover:text-[#123d32]">
                  {article.koreanTitle || article.originalTitle || "제목 미상"}
                </Link>
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
      <SurfaceCard className="min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#bdc9c2] px-4 py-3 sm:px-5">
          <h2 className="text-base font-semibold text-[#243b33]">판례 목록</h2>
          <p className="text-sm text-[#68756f]">
            총 {formatNumber(total)}건 · {formatNumber(from)}-{formatNumber(to)} 표시
          </p>
        </div>

        <div className="hidden grid-cols-[94px_100px_minmax(280px,1fr)_140px] gap-3 border-b border-[#cbd4ce] bg-[#f4f6f3] px-4 py-2.5 text-xs font-semibold text-[#53635d] xl:grid"><span>날짜</span><span>국가</span><span>제목</span><span>주제 / 조회</span></div>

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
