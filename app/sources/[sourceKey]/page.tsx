import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ArticleGrid } from "@/components/article-grid";
import { MetaRow } from "@/components/ui/meta-row";
import { PageShell } from "@/components/ui/page-shell";
import { SurfaceCard } from "@/components/ui/surface-card";
import { recordSiteEvent } from "@/lib/analytics/events";
import { getSourceByKey, listArticles } from "@/lib/db/queries";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata({ params }: { params: Promise<{ sourceKey: string }> }): Promise<Metadata> {
  const { sourceKey } = await params;
  const source = await getSourceByKey(sourceKey);
  if (!source) return {};
  return {
    title: source.name,
    description: `${source.jurisdiction} 공식 헌법재판 자료 수집 기관`,
    alternates: { canonical: `${getAppBaseUrl()}/sources/${source.sourceKey}` },
  };
}

export default async function SourceDetailPage({ params }: { params: Promise<{ sourceKey: string }> }) {
  const { sourceKey } = await params;
  const source = await getSourceByKey(sourceKey);
  if (!source) notFound();
  const articles = await listArticles({ source: source.sourceKey, pageSize: 30 });
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
      <SurfaceCard style={jurisdictionThemeStyle(themeForJurisdiction(source.jurisdiction))} className="mb-6 p-6">
        <p className="mb-2 text-sm font-semibold text-[color:var(--country-text)]">{source.jurisdiction}</p>
        <h1 className="text-3xl font-semibold tracking-normal text-ink sm:text-4xl">{source.name}</h1>
        <MetaRow
          className="mt-3"
          items={[
            `언어 ${source.language}`,
            source.isActive ? "수집 중" : "일시 중지",
            `공개 자료 ${articles.pageInfo.total.toLocaleString("ko-KR")}건`,
          ]}
        />
        <a href={source.baseUrl} target="_blank" rel="noreferrer" className="focus-ring mt-5 inline-flex min-h-11 items-center gap-2 rounded-lg border border-court/25 bg-court/5 px-4 text-sm font-semibold text-court transition hover:bg-court/10">
          공식 사이트
          <ExternalLink className="size-4" aria-hidden="true" />
        </a>
      </SurfaceCard>
      <ArticleGrid articles={articles.items} />
    </PageShell>
  );
}
