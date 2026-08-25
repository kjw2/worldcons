import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ChevronRight } from "lucide-react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ArticleGrid } from "@/components/article-grid";
import { TagPill } from "@/components/tag-pill";
import { PageShell } from "@/components/ui/page-shell";
import { recordSiteEvent } from "@/lib/analytics/events";
import { getTagBySlug, listTags } from "@/lib/db/queries";
import { tagMetadata } from "@/lib/seo/metadata";
import { MIN_INDEXABLE_TAG_ARTICLE_COUNT } from "@/lib/seo/public-urls";
import { formatDisplayDate } from "@/lib/utils/dates";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const result = await getTagBySlug(slug);
  if (!result) return {};
  return tagMetadata(result.tag);
}

export default async function TagDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await getTagBySlug(slug);
  if (!result) notFound();
  const relatedTags = (await listTags({ sort: "latest", minArticleCount: MIN_INDEXABLE_TAG_ARTICLE_COUNT })).filter((tag) => tag.slug !== result.tag.slug).slice(0, 8);
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
      <div className="mb-4 flex items-end justify-between gap-4"><div><h2 className="text-2xl font-semibold text-archive-ink">최신 관련 판례</h2><p className="mt-2 text-sm text-archive-muted">전체 {(result.tag.articleCount ?? result.articles.length).toLocaleString("ko-KR")}건 중 최신 {result.articles.length.toLocaleString("ko-KR")}건</p></div><Link href={`/list?tag=${encodeURIComponent(result.tag.slug)}`} className="focus-ring inline-flex items-center gap-2 rounded-sm text-sm font-semibold text-archive-accent hover:text-archive-accent-hover">전체 목록<ArrowRight className="size-4" aria-hidden="true" /></Link></div>
      <ArticleGrid articles={result.articles} />
    </PageShell>
  );
}
