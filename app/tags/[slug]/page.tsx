import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CalendarDays, ChevronRight, Hash, MessageSquareText } from "lucide-react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ArticleGrid } from "@/components/article-grid";
import { TagPill } from "@/components/tag-pill";
import { PageShell } from "@/components/ui/page-shell";
import { recordSiteEvent } from "@/lib/analytics/events";
import { getTagBySlug, listTags } from "@/lib/db/queries";
import { tagMetadata } from "@/lib/seo/metadata";
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
  const relatedTags = (await listTags({ sort: "latest" })).filter((tag) => tag.slug !== result.tag.slug).slice(0, 8);
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
      <nav className="mb-6 flex items-center gap-1.5 text-xs text-[#73807b]" aria-label="현재 위치"><Link href="/" className="focus-ring rounded-sm hover:text-[#123d32]">홈</Link><ChevronRight className="size-3" aria-hidden="true" /><Link href="/tags" className="focus-ring rounded-sm hover:text-[#123d32]">주제</Link><ChevronRight className="size-3" aria-hidden="true" /><span>{result.tag.name}</span></nav>
      <section className="mb-7 border-b border-[#b8c5be] pb-7">
        <p className="archive-kicker">{result.tag.type}</p>
        <h1 className="archive-serif mt-2 text-4xl font-semibold text-[#123d32] sm:text-5xl">주제: {result.tag.name}</h1>
        <p className="mt-4 max-w-4xl text-sm leading-7 text-[#596862]">{result.tag.description || `‘${result.tag.name}’ 주제가 연결된 헌법재판 자료를 모아 최신순으로 제공합니다.`}</p>
      </section>
      <section className="mb-7 grid border border-[#d4dcd7] bg-white md:grid-cols-[1fr_1fr_2fr]" aria-label="주제 현황">
        <div className="flex min-h-24 items-center gap-3 border-b border-[#dce2de] p-4 md:border-b-0 md:border-r"><MessageSquareText className="size-5 text-[#315b4d]" aria-hidden="true" /><div><p className="text-xs text-[#74817c]">관련 판례</p><p className="archive-serif mt-1 text-xl font-semibold text-[#243b33]">{(result.tag.articleCount ?? result.articles.length).toLocaleString("ko-KR")}건</p></div></div>
        <div className="flex min-h-24 items-center gap-3 border-b border-[#dce2de] p-4 md:border-b-0 md:border-r"><CalendarDays className="size-5 text-[#315b4d]" aria-hidden="true" /><div><p className="text-xs text-[#74817c]">최근 업데이트</p><p className="mt-1 font-semibold text-[#243b33]">{formatDisplayDate(result.tag.latestArticleAt)}</p></div></div>
        <div className="flex min-h-24 items-start gap-3 p-4"><Hash className="mt-1 size-5 shrink-0 text-[#315b4d]" aria-hidden="true" /><div><p className="text-xs text-[#74817c]">다른 최신 주제</p><div className="mt-2 flex flex-wrap gap-2">{relatedTags.slice(0, 5).map((tag) => <TagPill key={tag.slug} tag={tag} />)}</div></div></div>
      </section>
      <div className="mb-4 flex items-end justify-between gap-4"><div><p className="archive-kicker">Related cases</p><h2 className="archive-serif mt-1 text-3xl font-semibold text-[#123d32]">최신 관련 판례</h2><p className="mt-2 text-xs text-[#74817c]">전체 {(result.tag.articleCount ?? result.articles.length).toLocaleString("ko-KR")}건 중 최신 {result.articles.length.toLocaleString("ko-KR")}건</p></div><Link href={`/list?tag=${encodeURIComponent(result.tag.slug)}`} className="focus-ring inline-flex items-center gap-2 rounded-sm text-sm font-semibold text-[#345a4d] hover:text-[#123d32]">전체 목록<ArrowRight className="size-4" aria-hidden="true" /></Link></div>
      <ArticleGrid articles={result.articles} />
    </PageShell>
  );
}
