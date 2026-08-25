import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ChevronRight, ExternalLink } from "lucide-react";
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
        <div className="border-b border-archive-line px-1 py-4 lg:border-b-0 lg:border-r lg:px-4"><dt className="text-xs font-medium text-archive-muted">공개 판례</dt><dd className="mt-1 text-sm font-semibold tabular-nums text-archive-heading">{articles.pageInfo.total.toLocaleString("ko-KR")}건</dd></div>
        <div className="border-b border-archive-line px-1 py-4 sm:border-b-0 sm:border-r lg:px-4"><dt className="text-xs font-medium text-archive-muted">최근 업데이트</dt><dd className="mt-1 text-sm font-semibold text-archive-heading">{formatDisplayDate(latestArticleAt)}</dd></div>
        <div className="px-1 py-4 lg:px-4"><dt className="text-xs font-medium text-archive-muted">자료 기준</dt><dd className="mt-1 text-sm font-semibold text-archive-heading">{dateBasis ?? `원문 ${displaySourceLanguageLabel(source.language)}`}</dd></div>
      </dl>
      <div className="mb-4 flex items-end justify-between gap-4"><h2 className="text-2xl font-semibold text-archive-ink">최신 판례</h2><Link href={`/list?source=${encodeURIComponent(source.sourceKey)}`} className="focus-ring inline-flex items-center gap-2 rounded-sm text-sm font-semibold text-archive-accent hover:text-archive-accent-hover">전체 보기<ArrowRight className="size-4" aria-hidden="true" /></Link></div>
      <ArticleGrid articles={articles.items} />
    </PageShell>
  );
}
