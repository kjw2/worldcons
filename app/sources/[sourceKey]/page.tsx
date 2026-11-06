import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { freshnessAwarePublicCache as unstable_cache } from "@/lib/public-freshness-cache";
import { ArticleGrid } from "@/components/article-grid";
import { PageShell } from "@/components/ui/page-shell";
import { recordSiteEvent } from "@/lib/analytics/events";
import { getSourceByKey, listArticles } from "@/lib/db/queries";
import { PUBLIC_ARTICLES_CACHE_TAG } from "@/lib/public-content-cache";
import {
  isOutOfRangeSourceArchivePage,
  parseSourceArchivePage,
  sourceArchiveMetadata,
  sourceArchivePageHref,
  SOURCE_ARCHIVE_PAGE_SIZE,
} from "@/lib/seo/source-detail-pagination";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";
import { displayJurisdictionFlag, displayJurisdictionLabel, displaySourceLabel, displaySourceLanguageLabel } from "@/lib/ui/source-labels";
import { formatDisplayDate } from "@/lib/utils/dates";
import { resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";
import { safeExternalUrl } from "@/lib/utils/safe-url";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SourceDetailPageProps = { params: Promise<{ sourceKey: string }>; searchParams?: Promise<SearchParams> };

const getSourceArchiveArticles = unstable_cache(
  async (sourceKey: string, page: number, count: "exact" | "none") =>
    listArticles({ source: sourceKey, page, pageSize: SOURCE_ARCHIVE_PAGE_SIZE, count }),
  ["source-archive-articles-v1"],
  { revalidate: 60, tags: [PUBLIC_ARTICLES_CACHE_TAG] },
);

export async function generateMetadata({ params, searchParams }: SourceDetailPageProps): Promise<Metadata> {
  const { sourceKey } = await params;
  const query = await resolveSearchParams(searchParams);
  const page = parseSourceArchivePage(query.page);
  const source = await getSourceByKey(sourceKey);
  if (!source) return {};
  return sourceArchiveMetadata(source, page);
}

export default async function SourceDetailPage({ params, searchParams }: SourceDetailPageProps) {
  const { sourceKey } = await params;
  const query = await resolveSearchParams(searchParams);
  const page = parseSourceArchivePage(query.page);
  if (page === null) notFound();
  const source = await getSourceByKey(sourceKey);
  if (!source) notFound();
  const articles = await getSourceArchiveArticles(source.sourceKey, page, page === 1 ? "exact" : "none");
  if (isOutOfRangeSourceArchivePage(page, articles.items.length)) notFound();
  const isFirstPage = page === 1;
  const hasNextPage = Boolean(articles.pageInfo.hasMore);
  const dateBasis = source.sourceKey === "es-tribunal-constitucional" ? "날짜 기준 HJ FECHA_REGISTRO" : null;
  const sourceHref = safeExternalUrl(source.baseUrl);
  const latestArticleAt = articles.items[0]?.originalPublishedAt ?? articles.items[0]?.summarizedAt;
  await recordSiteEvent(
    {
      eventType: "source_view",
      path: isFirstPage ? `/sources/${source.sourceKey}` : `/sources/${source.sourceKey}?page=${page}`,
      sourceKey: source.sourceKey,
      jurisdiction: source.jurisdiction,
      institutionName: source.name,
      resultCount: articles.pageInfo.total,
    },
    await headers(),
  );

  return (
    <PageShell className="max-w-[1248px] py-6 sm:py-8">
      <nav className="mb-6 flex items-center gap-1.5 text-xs text-archive-muted" aria-label="현재 위치"><Link href="/" className="focus-ring rounded-sm hover:text-archive-accent">홈</Link><ChevronRight className="size-3" aria-hidden="true" /><Link href="/sources" className="focus-ring rounded-sm hover:text-archive-accent">기관</Link><ChevronRight className="size-3" aria-hidden="true" /><span>{displaySourceLabel(source)}</span></nav>
      <section style={jurisdictionThemeStyle(themeForJurisdiction(source.jurisdiction))} className="mb-7 border-b border-archive-line-strong pb-7">
        <p className="text-sm font-semibold text-[color:var(--country-text)]"><span className="mr-2" aria-hidden="true">{displayJurisdictionFlag(source.jurisdiction)}</span>{displayJurisdictionLabel(source.jurisdiction)}</p>
        <h1 className="mt-2 text-3xl font-semibold text-archive-ink sm:text-4xl">{displaySourceLabel(source)}</h1>
        {source.name !== displaySourceLabel(source) ? <p className="mt-2 text-sm text-archive-muted">{source.name}</p> : null}
        <p className="mt-4 max-w-[72ch] text-[15px] leading-7 text-archive-text">공식 공개자료를 수집해 한국어 요약과 원문 링크로 제공합니다.</p>
        {sourceHref ? (
        <a href={sourceHref} target="_blank" rel="noreferrer" className="focus-ring mt-4 inline-flex min-h-10 items-center gap-2 rounded-sm border border-archive-line-strong px-3 text-sm font-semibold text-archive-accent transition-colors hover:bg-archive-surface-soft">
          공식 사이트
          <ExternalLink className="size-4" aria-hidden="true" />
        </a>
        ) : null}
      </section>
      <dl className="mb-8 grid border-y border-archive-line-strong bg-white sm:grid-cols-2 lg:grid-cols-4" aria-label="기관 현황">
        <div className="border-b border-archive-line px-1 py-4 sm:border-r lg:border-b-0 lg:px-4"><dt className="text-xs font-medium text-archive-muted">국가</dt><dd className="mt-1 text-sm font-semibold text-archive-heading">{displayJurisdictionLabel(source.jurisdiction)}</dd></div>
        <div className="border-b border-archive-line px-1 py-4 lg:border-b-0 lg:border-r lg:px-4"><dt className="text-xs font-medium text-archive-muted">{isFirstPage ? "공개 판례" : "현재 페이지"}</dt><dd className="mt-1 text-sm font-semibold tabular-nums text-archive-heading">{isFirstPage ? `${articles.pageInfo.total.toLocaleString("ko-KR")}건` : `${page}페이지`}</dd></div>
        <div className="border-b border-archive-line px-1 py-4 sm:border-b-0 sm:border-r lg:px-4"><dt className="text-xs font-medium text-archive-muted">{isFirstPage ? "최근 업데이트" : "이 페이지 최신"}</dt><dd className="mt-1 text-sm font-semibold text-archive-heading">{formatDisplayDate(latestArticleAt)}</dd></div>
        <div className="px-1 py-4 lg:px-4"><dt className="text-xs font-medium text-archive-muted">자료 기준</dt><dd className="mt-1 text-sm font-semibold text-archive-heading">{dateBasis ?? `원문 ${displaySourceLanguageLabel(source.language)}`}</dd></div>
      </dl>
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-archive-ink">{isFirstPage ? "최신 판례" : "판례 목록"}</h2>
          {isFirstPage ? null : <p className="mt-2 text-sm text-archive-muted">{page}페이지 · {articles.items.length.toLocaleString("ko-KR")}건 표시</p>}
        </div>
        {isFirstPage ? (
          <Link href={`/list?source=${encodeURIComponent(source.sourceKey)}`} className="focus-ring inline-flex items-center gap-2 rounded-sm text-sm font-semibold text-archive-accent hover:text-archive-accent-hover">전체 보기<ArrowRight className="size-4" aria-hidden="true" /></Link>
        ) : (
          <Link href={sourceArchivePageHref(source.sourceKey, 1)} className="focus-ring inline-flex items-center gap-2 rounded-sm text-sm font-semibold text-archive-accent hover:text-archive-accent-hover">최신 판례<ArrowRight className="size-4" aria-hidden="true" /></Link>
        )}
      </div>
      <ArticleGrid articles={articles.items} />
      {!isFirstPage || hasNextPage ? (
        <nav className="mt-6 flex flex-wrap items-center justify-center gap-2 border-t border-archive-line-strong pt-5" aria-label="기관 판례 페이지 이동">
          {page > 1 ? (
            <Link href={sourceArchivePageHref(source.sourceKey, page - 1)} rel="prev" className="focus-ring inline-flex min-h-9 items-center gap-1 border border-archive-line px-3 text-sm hover:text-archive-accent">
              <ChevronLeft className="size-4" aria-hidden="true" />
              이전
            </Link>
          ) : null}
          <span aria-current="page" className="focus-ring inline-flex min-h-9 items-center border border-archive-accent bg-archive-tint px-3 text-sm font-bold text-archive-accent">{page}페이지</span>
          {hasNextPage ? (
            <Link href={sourceArchivePageHref(source.sourceKey, page + 1)} rel="next" className="focus-ring inline-flex min-h-9 items-center gap-1 border border-archive-line px-3 text-sm hover:text-archive-accent">
              다음
              <ChevronRight className="size-4" aria-hidden="true" />
            </Link>
          ) : null}
        </nav>
      ) : null}
    </PageShell>
  );
}
