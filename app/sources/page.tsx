import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { ArrowRight, ExternalLink, Landmark } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageShell } from "@/components/ui/page-shell";
import { SectionHeading } from "@/components/ui/section-heading";
import { SurfaceCard } from "@/components/ui/surface-card";
import { recordSiteEvent } from "@/lib/analytics/events";
import { listSources } from "@/lib/db/queries";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";
import { displayJurisdictionFlag, displayJurisdictionLabel, displaySourceLabel, displaySourceLanguageLabel } from "@/lib/ui/source-labels";
import { safeExternalUrl } from "@/lib/utils/safe-url";

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
        className="mb-7 border-b border-[#bcc8c1] pb-6"
        eyebrow="Institutions"
        title="헌법재판 기관"
        description="World Cons가 공식 자료를 수집하는 국가별 헌법재판기관과 공개 판례를 확인합니다."
      />
      {sources.length === 0 ? (
        <EmptyState title="등록된 수집 기관이 없습니다" description="공식 기관이 추가되면 이곳에서 국가와 언어별로 확인할 수 있습니다." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {sources.map((source) => {
            const sourceHref = safeExternalUrl(source.baseUrl);
            return (
            <SurfaceCard key={source.sourceKey} style={jurisdictionThemeStyle(themeForJurisdiction(source.jurisdiction))} className="relative flex min-h-60 h-full flex-col overflow-hidden p-5 sm:p-6">
              <div className="relative z-10 flex items-start gap-4"><span className="text-4xl" aria-hidden="true">{displayJurisdictionFlag(source.jurisdiction)}</span><div><p className="text-sm font-semibold text-[color:var(--country-text)]">{displayJurisdictionLabel(source.jurisdiction)}</p><h2 className="archive-serif mt-1 text-2xl font-semibold leading-snug text-[#173d33]">{displaySourceLabel(source)}</h2>{source.name !== displaySourceLabel(source) ? <p className="mt-1 text-xs text-[#74817c]">{source.name}</p> : null}</div></div>
              <dl className="mt-4 space-y-2 text-sm text-ink-muted">
                <div className="flex items-center justify-between gap-3">
                  <dt>기관 코드</dt>
                  <dd className="font-medium text-ink">{source.sourceKey}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>언어</dt>
                  <dd className="font-medium text-ink">{displaySourceLanguageLabel(source.language)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>상태</dt>
                  <dd className="font-medium text-ink">{source.isActive ? "수집 중" : "일시 중지"}</dd>
                </div>
              </dl>
              <div className="mt-auto flex flex-wrap gap-2 pt-5">
                <Link href={`/sources/${source.sourceKey}`} className="focus-ring inline-flex min-h-10 items-center gap-2 rounded-sm bg-[#123d32] px-3.5 text-sm font-semibold text-white transition hover:bg-[#285748]">
                  기관 보기<ArrowRight className="size-4" aria-hidden="true" />
                </Link>
                {sourceHref ? (
                <a href={sourceHref} target="_blank" rel="noreferrer" className="focus-ring inline-flex min-h-10 items-center gap-1.5 rounded-sm border border-[#c8d2cc] px-3.5 text-sm font-semibold text-[#5b6964] transition hover:border-[#879a90] hover:text-[#123d32]">
                  공식 사이트
                  <ExternalLink className="size-4" aria-hidden="true" />
                </a>
                ) : null}
              </div>
              <Landmark className="pointer-events-none absolute -bottom-8 -right-6 size-40 stroke-1 text-[color:var(--country-accent)] opacity-[0.08]" aria-hidden="true" />
            </SurfaceCard>
          );
          })}
        </div>
      )}
    </PageShell>
  );
}
