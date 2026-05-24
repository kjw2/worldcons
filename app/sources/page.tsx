import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { ExternalLink } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageShell } from "@/components/ui/page-shell";
import { SectionHeading } from "@/components/ui/section-heading";
import { SurfaceCard } from "@/components/ui/surface-card";
import { recordSiteEvent } from "@/lib/analytics/events";
import { listSources } from "@/lib/db/queries";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "수집 대상 기관",
  description: "세계 헌법재판 큐레이션의 공식 수집 기관과 최신 자료를 확인합니다.",
  alternates: { canonical: `${getAppBaseUrl()}/sources` },
};

export default async function SourcesPage() {
  const sources = await listSources();
  await recordSiteEvent(
    {
      eventType: "page_view",
      path: "/sources",
      resultCount: sources.length,
    },
    await headers(),
  );

  return (
    <PageShell>
      <SectionHeading
        className="mb-6"
        eyebrow="공식 기관"
        title="수집 대상 기관"
        description="각 국가의 공식 헌법재판 기관별 최신 자료와 원문 위치를 확인합니다."
      />
      {sources.length === 0 ? (
        <EmptyState title="등록된 수집 기관이 없습니다" description="공식 기관이 추가되면 이곳에서 국가와 언어별로 확인할 수 있습니다." />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {sources.map((source) => (
            <SurfaceCard key={source.sourceKey} style={jurisdictionThemeStyle(themeForJurisdiction(source.jurisdiction))} className="flex h-full flex-col p-5">
              <p className="text-sm font-semibold text-[color:var(--country-text)]">{source.jurisdiction}</p>
              <h2 className="mt-2 text-xl font-semibold leading-snug text-ink">{source.name}</h2>
              <dl className="mt-4 space-y-2 text-sm text-ink-muted">
                <div className="flex items-center justify-between gap-3">
                  <dt>기관 코드</dt>
                  <dd className="font-medium text-ink">{source.sourceKey}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>언어</dt>
                  <dd className="font-medium text-ink">{source.language}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>상태</dt>
                  <dd className="font-medium text-ink">{source.isActive ? "수집 중" : "일시 중지"}</dd>
                </div>
              </dl>
              <div className="mt-auto flex flex-wrap gap-2 pt-5">
                <Link href={`/sources/${source.sourceKey}`} className="focus-ring inline-flex min-h-10 items-center rounded-lg bg-primary px-3.5 text-sm font-semibold text-white transition hover:bg-primary/90">
                  자세히 보기
                </Link>
                <a href={source.baseUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line px-3.5 text-sm font-semibold text-ink-muted transition hover:border-line-strong hover:text-ink">
                  공식 사이트
                  <ExternalLink className="size-4" aria-hidden="true" />
                </a>
              </div>
            </SurfaceCard>
          ))}
        </div>
      )}
    </PageShell>
  );
}
