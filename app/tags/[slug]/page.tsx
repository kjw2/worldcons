import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ArticleGrid } from "@/components/article-grid";
import { TagPill } from "@/components/tag-pill";
import { PageShell } from "@/components/ui/page-shell";
import { recordSiteEvent } from "@/lib/analytics/events";
import { getPaginatedTagBySlug, getTagSummaryBySlug, listTags } from "@/lib/db/queries";
import { paginationWindow } from "@/lib/navigation/pagination";
import { MIN_INDEXABLE_TAG_ARTICLE_COUNT } from "@/lib/seo/public-urls";
import { paginatedTagMetadata, parseTagDetailPage, TAG_DETAIL_PAGE_SIZE, tagDetailPageHref } from "@/lib/seo/tag-detail-pagination";
import { readTagDetailSafely } from "@/lib/seo/tag-detail-read";
import { formatDisplayDate } from "@/lib/utils/dates";
import { resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type TagPageProps = { params: Promise<{ slug: string }>; searchParams?: Promise<SearchParams> };

export async function generateMetadata({ params, searchParams }: TagPageProps): Promise<Metadata> {
  const { slug } = await params;
  const query = await resolveSearchParams(searchParams);
  const page = parseTagDetailPage(query.page);
  const tag = await readTagDetailSafely("metadata", () => getTagSummaryBySlug(slug));
  if (!tag) return {};
  if (page === null) return { robots: { index: false, follow: true } };
  return paginatedTagMetadata(tag, page);
}

export default async function TagDetailPage({ params, searchParams }: TagPageProps) {
  const { slug } = await params;
  const query = await resolveSearchParams(searchParams);
  const page = parseTagDetailPage(query.page);
  if (page === null) notFound();
  const result = await readTagDetailSafely("articles", () => getPaginatedTagBySlug(slug, page, TAG_DETAIL_PAGE_SIZE));
  if (!result) notFound();
  const totalPages = Math.max(1, Math.ceil(result.pageInfo.total / TAG_DETAIL_PAGE_SIZE));
  if (page > totalPages) notFound();
  // Related topics are optional enrichment; a failure must never break the
  // core court-case article list or its crawler links.
  const relatedTags = (await listTags({ sort: "latest", minArticleCount: MIN_INDEXABLE_TAG_ARTICLE_COUNT, limit: 9 })
    .catch(() => {
      console.warn(JSON.stringify({ event: "worldcons_tag_detail_related_unavailable" }));
      return [];
    })).filter((tag) => tag.slug !== result.tag.slug).slice(0, 8);
  await recordSiteEvent(
    {
      eventType: "tag_view",
      path: `/tags/${result.tag.slug}`,
      tagSlug: result.tag.slug,
      tagName: result.tag.name,
      resultCount: result.tag.articleCount ?? result.articles.length,
    },
    await headers(),
  );

  return (
    <PageShell className="max-w-[1248px] py-6 sm:py-8">
      <nav className="mb-6 flex items-center gap-1.5 text-xs text-archive-muted" aria-label="현재 위치"><Link href="/" className="focus-ring rounded-sm hover:text-archive-accent">홈</Link><ChevronRight className="size-3" aria-hidden="true" /><Link href="/tags" className="focus-ring rounded-sm hover:text-archive-accent">주제</Link><ChevronRight className="size-3" aria-hidden="true" /><span>{result.tag.name}</span></nav>
      <section className="mb-7 border-b border-archive-line-strong pb-7">
        <h1 className="text-3xl font-semibold text-archive-ink sm:text-4xl">{result.tag.name}</h1>
        <p className="mt-3 max-w-[72ch] text-[15px] leading-7 text-archive-text">{result.tag.description || `‘${result.tag.name}’ 주제가 연결된 헌법재판 자료를 최신순으로 제공합니다.`}</p>
      </section>
      <dl className="mb-8 grid border-y border-archive-line-strong bg-white md:grid-cols-[1fr_1fr_2fr]" aria-label="주제 현황">
        <div className="border-b border-archive-line px-1 py-4 md:border-b-0 md:border-r md:px-4"><dt className="text-xs font-medium text-archive-muted">관련 판례</dt><dd className="mt-1 text-base font-semibold tabular-nums text-archive-heading">{(result.tag.articleCount ?? result.articles.length).toLocaleString("ko-KR")}건</dd></div>
        <div className="border-b border-archive-line px-1 py-4 md:border-b-0 md:border-r md:px-4"><dt className="text-xs font-medium text-archive-muted">최근 업데이트</dt><dd className="mt-1 text-sm font-semibold text-archive-heading">{formatDisplayDate(result.tag.latestArticleAt)}</dd></div>
        <div className="px-1 py-4 md:px-4"><dt className="text-xs font-medium text-archive-muted">함께 볼 주제</dt><dd className="mt-2 flex flex-wrap gap-2">{relatedTags.slice(0, 5).map((tag) => <TagPill key={tag.slug} tag={tag} />)}</dd></div>
      </dl>
      <div className="mb-4 flex items-end justify-between gap-4"><div><h2 className="text-2xl font-semibold text-archive-ink">최신 관련 판례</h2><p className="mt-2 text-sm text-archive-muted">연결된 판례 {result.pageInfo.total.toLocaleString("ko-KR")}건 · 현재 페이지 {result.articles.length.toLocaleString("ko-KR")}건 · {page}/{totalPages}페이지</p></div><a href={`/list?tag=${encodeURIComponent(result.tag.slug)}`} className="focus-ring inline-flex items-center gap-2 rounded-sm text-sm font-semibold text-archive-accent hover:text-archive-accent-hover">전체 목록<ArrowRight className="size-4" aria-hidden="true" /></a></div>
      <ArticleGrid articles={result.articles} />
      {totalPages > 1 ? (
        <nav className="mt-6 flex flex-wrap items-center justify-center gap-2 border-t border-archive-line-strong pt-5" aria-label="관련 판례 페이지 이동">
          {page > 1 ? <Link href={tagDetailPageHref(result.tag.slug, page - 1)} className="focus-ring inline-flex min-h-9 items-center gap-1 border border-archive-line px-3 text-sm"><ChevronLeft className="size-4" />이전</Link> : null}
          {paginationWindow(page, totalPages).map((target) => (
            <Link key={target} href={tagDetailPageHref(result.tag.slug, target)} aria-current={target === page ? "page" : undefined} className={target === page ? "focus-ring inline-flex size-9 items-center justify-center border border-archive-accent bg-archive-tint text-sm font-bold text-archive-accent" : "focus-ring inline-flex size-9 items-center justify-center border border-archive-line text-sm hover:text-archive-accent"}>{target}</Link>
          ))}
          {page < totalPages ? <Link href={tagDetailPageHref(result.tag.slug, page + 1)} className="focus-ring inline-flex min-h-9 items-center gap-1 border border-archive-line px-3 text-sm">다음<ChevronRight className="size-4" /></Link> : null}
        </nav>
      ) : null}
    </PageShell>
  );
}
