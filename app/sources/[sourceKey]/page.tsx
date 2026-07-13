import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CalendarDays, ChevronRight, ExternalLink, FileText, Globe2, Landmark } from "lucide-react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ArticleGrid } from "@/components/article-grid";
import { PageShell } from "@/components/ui/page-shell";
import { recordSiteEvent } from "@/lib/analytics/events";
import { getSourceByKey, listArticles } from "@/lib/db/queries";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";
import { displayJurisdictionFlag, displayJurisdictionLabel, displaySourceLabel, displaySourceLanguageLabel } from "@/lib/ui/source-labels";
import { formatDisplayDate } from "@/lib/utils/dates";
import { safeExternalUrl } from "@/lib/utils/safe-url";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata({ params }: { params: Promise<{ sourceKey: string }> }): Promise<Metadata> {
  const { sourceKey } = await params;
  const source = await getSourceByKey(sourceKey);
  if (!source) return {};
  return {
    title: displaySourceLabel(source),
    description: `${displayJurisdictionLabel(source.jurisdiction)} 공식 헌법재판 자료 수집 기관`,
    alternates: { canonical: `${getAppBaseUrl()}/sources/${source.sourceKey}` },
  };
}

export default async function SourceDetailPage({ params }: { params: Promise<{ sourceKey: string }> }) {
  const { sourceKey } = await params;
  const source = await getSourceByKey(sourceKey);
  if (!source) notFound();
  const articles = await listArticles({ source: source.sourceKey, pageSize: 30 });
  const dateBasis = source.sourceKey === "es-tribunal-constitucional" ? "날짜 기준 HJ FECHA_REGISTRO" : null;
  const sourceHref = safeExternalUrl(source.baseUrl);
  const latestArticleAt = articles.items[0]?.originalPublishedAt ?? articles.items[0]?.summarizedAt;
  await recordSiteEvent(
    {
      eventType: "source_view",
      path: `/sources/${source.sourceKey}`,
      sourceKey: source.sourceKey,
      jurisdiction: source.jurisdiction,
      institutionName: source.name,
      resultCount: articles.pageInfo.total,
    },
    await headers(),
  );

  return (
    <PageShell>
      <nav className="mb-6 flex items-center gap-1.5 text-xs text-[#73807b]" aria-label="현재 위치"><Link href="/" className="focus-ring rounded-sm hover:text-[#123d32]">홈</Link><ChevronRight className="size-3" aria-hidden="true" /><Link href="/sources" className="focus-ring rounded-sm hover:text-[#123d32]">기관</Link><ChevronRight className="size-3" aria-hidden="true" /><span>{displaySourceLabel(source)}</span></nav>
      <section style={jurisdictionThemeStyle(themeForJurisdiction(source.jurisdiction))} className="relative mb-6 min-h-56 overflow-hidden border-b border-[#b8c5be] pb-7 pr-4 sm:pr-[28%]">
        <p className="text-4xl" aria-hidden="true">{displayJurisdictionFlag(source.jurisdiction)}</p>
        <p className="mt-4 text-sm font-semibold text-[color:var(--country-text)]">{displayJurisdictionLabel(source.jurisdiction)}</p>
        <h1 className="archive-serif mt-2 text-4xl font-semibold text-[#123d32] sm:text-5xl">{displaySourceLabel(source)}</h1>
        {source.name !== displaySourceLabel(source) ? <p className="mt-2 text-base text-[#56655f]">{source.name}</p> : null}
        <p className="mt-5 max-w-3xl text-sm leading-7 text-[#596862]">{displayJurisdictionLabel(source.jurisdiction)}의 공식 헌법재판 자료를 수집해 한국어 요약과 원문 링크로 제공합니다.</p>
        {sourceHref ? (
        <a href={sourceHref} target="_blank" rel="noreferrer" className="focus-ring mt-5 inline-flex min-h-11 items-center gap-2 rounded-sm border border-[#9fb1a7] bg-[#f3f7f4] px-4 text-sm font-semibold text-[#123d32] transition hover:bg-[#e7efea]">
          공식 사이트
          <ExternalLink className="size-4" aria-hidden="true" />
        </a>
        ) : null}
        <Landmark className="pointer-events-none absolute -bottom-12 right-0 size-72 stroke-[0.8] text-[color:var(--country-accent)] opacity-[0.11]" aria-hidden="true" />
      </section>
      <section className="mb-8 grid border border-[#d4dcd7] bg-white sm:grid-cols-2 lg:grid-cols-4" aria-label="기관 현황">
        <div className="flex min-h-24 items-center gap-3 border-b border-[#dce2de] p-4 sm:border-r lg:border-b-0"><Globe2 className="size-5 text-[#315b4d]" aria-hidden="true" /><div><p className="text-xs text-[#74817c]">국가</p><p className="mt-1 font-semibold text-[#243b33]">{displayJurisdictionLabel(source.jurisdiction)}</p></div></div>
        <div className="flex min-h-24 items-center gap-3 border-b border-[#dce2de] p-4 lg:border-b-0 lg:border-r"><FileText className="size-5 text-[#315b4d]" aria-hidden="true" /><div><p className="text-xs text-[#74817c]">공개 판례</p><p className="archive-serif mt-1 text-xl font-semibold text-[#243b33]">{articles.pageInfo.total.toLocaleString("ko-KR")}건</p></div></div>
        <div className="flex min-h-24 items-center gap-3 border-b border-[#dce2de] p-4 sm:border-b-0 sm:border-r"><CalendarDays className="size-5 text-[#315b4d]" aria-hidden="true" /><div><p className="text-xs text-[#74817c]">최근 업데이트</p><p className="mt-1 font-semibold text-[#243b33]">{formatDisplayDate(latestArticleAt)}</p></div></div>
        <div className="flex min-h-24 items-center gap-3 p-4"><Landmark className="size-5 text-[#315b4d]" aria-hidden="true" /><div><p className="text-xs text-[#74817c]">자료 기준</p><p className="mt-1 font-semibold text-[#243b33]">{dateBasis ?? `원문 ${displaySourceLanguageLabel(source.language)}`}</p></div></div>
      </section>
      <div className="mb-4 flex items-end justify-between gap-4"><div><p className="archive-kicker">Latest cases</p><h2 className="archive-serif mt-1 text-3xl font-semibold text-[#123d32]">최신 판례</h2></div><Link href={`/list?source=${encodeURIComponent(source.sourceKey)}`} className="focus-ring inline-flex items-center gap-2 rounded-sm text-sm font-semibold text-[#345a4d] hover:text-[#123d32]">전체 보기<ArrowRight className="size-4" aria-hidden="true" /></Link></div>
      <ArticleGrid articles={articles.items} />
    </PageShell>
  );
}
