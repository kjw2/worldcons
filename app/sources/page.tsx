import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { ExternalLink } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageShell } from "@/components/ui/page-shell";
import { recordSiteEvent } from "@/lib/analytics/events";
import { listSources } from "@/lib/db/queries";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { displayJurisdictionLabel, displaySourceLabel, displaySourceLanguageLabel } from "@/lib/ui/source-labels";
import { safeExternalUrl } from "@/lib/utils/safe-url";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "국가·기관",
  description: "WORLD CONS가 수록하는 세계 헌법재판기관과 수집 상태를 확인합니다.",
  alternates: { canonical: `${getAppBaseUrl()}/sources` },
};

export default async function SourcesPage() {
  const sources = await listSources();
  await recordSiteEvent({ eventType: "page_view", path: "/sources", resultCount: sources.length }, await headers());

  const grouped = sources.reduce<Record<string, typeof sources>>((acc, source) => {
    (acc[source.jurisdiction] ??= []).push(source);
    return acc;
  }, {});

  return (
    <PageShell className="max-w-[1248px] py-6 sm:py-8">
      <header className="mb-8 border-b border-archive-line-strong pb-6">
        <h1 className="text-3xl font-semibold text-archive-ink">헌법재판기관</h1>
        <p className="mt-3 max-w-[72ch] text-[15px] leading-7 text-archive-text">WORLD CONS가 공식 공개자료를 수집·정리하는 국가와 헌법재판기관을 확인할 수 있습니다.</p>
      </header>

      {sources.length === 0 ? (
        <EmptyState title="등록된 수집 기관이 없습니다" description="공식 기관이 추가되면 이곳에서 국가와 언어별로 확인할 수 있습니다." />
      ) : (
        <div className="space-y-10">
          {Object.entries(grouped).map(([jurisdiction, rows]) => (
            <section key={jurisdiction} aria-labelledby={`jurisdiction-${jurisdiction}`}>
              <div className="border-y border-archive-line-strong py-3">
                <h2 id={`jurisdiction-${jurisdiction}`} className="text-xl font-bold text-archive-ink">{displayJurisdictionLabel(jurisdiction)}</h2>
              </div>
              <div>
                {rows.map((source) => {
                  const sourceHref = safeExternalUrl(source.baseUrl);
                  return (
                    <div key={source.sourceKey} className="grid gap-3 border-b border-archive-line py-5 sm:grid-cols-[minmax(0,1fr)_150px_120px_auto] sm:items-center sm:gap-5 sm:px-2">
                      <div className="min-w-0">
                        <Link href={`/sources/${source.sourceKey}`} className="focus-ring text-[17px] font-bold text-archive-heading hover:text-archive-accent">
                          {displaySourceLabel(source)}
                        </Link>
                        {source.name !== displaySourceLabel(source) ? <p className="mt-1 text-sm text-archive-muted">{source.name}</p> : null}
                        <p className="mt-1 text-xs text-archive-subtle">기관 코드 {source.sourceKey}</p>
                      </div>
                      <div className="text-sm text-archive-text">
                        <span className="block text-xs text-archive-muted">원문 언어</span>
                        <span className="mt-1 block font-semibold">{displaySourceLanguageLabel(source.language)}</span>
                      </div>
                      <div className="text-sm text-archive-text">
                        <span className="block text-xs text-archive-muted">수집 상태</span>
                        <span className="mt-1 block font-semibold">{source.isActive ? "수집 중" : "일시 중지"}</span>
                      </div>
                      <div className="flex items-center gap-3 text-sm font-semibold">
                        <Link href={`/sources/${source.sourceKey}`} className="focus-ring text-archive-accent hover:text-archive-accent-hover">기관 보기 →</Link>
                        {sourceHref ? <a href={sourceHref} target="_blank" rel="noreferrer" aria-label={`${displaySourceLabel(source)} 공식 사이트`} className="focus-ring text-archive-muted hover:text-archive-accent"><ExternalLink className="size-4" aria-hidden="true" /></a> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageShell>
  );
}
