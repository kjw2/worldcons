import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { BookOpen } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageShell } from "@/components/ui/page-shell";
import { SectionHeading } from "@/components/ui/section-heading";
import { surfaceCardClassName } from "@/components/ui/surface-card";
import { recordSiteEvent } from "@/lib/analytics/events";
import { listGlossaryTerms } from "@/lib/db/queries";
import { getAppBaseUrl } from "@/lib/seo/metadata";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "헌법재판 용어사전",
  description: "헌법재판 관련 권리, 절차, 원칙, 국가별 제도 용어를 정리합니다.",
  alternates: { canonical: `${getAppBaseUrl()}/glossary` },
};

export default async function GlossaryPage() {
  const terms = await listGlossaryTerms();
  await recordSiteEvent(
    {
      eventType: "page_view",
      path: "/glossary",
      resultCount: terms.length,
    },
    await headers(),
  );

  return (
    <PageShell>
      <SectionHeading
        className="mb-6"
        eyebrow="용어사전"
        title="헌법재판 용어"
        description="권리, 절차, 심사 기준, 국가별 제도 용어를 짧은 설명과 관련 태그로 확인합니다."
      />
      {terms.length === 0 ? (
        <EmptyState title="등록된 용어가 없습니다" description="헌법재판 관련 용어가 추가되면 이곳에서 찾아볼 수 있습니다." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {terms.map((term) => (
            <Link key={term.slug} href={`/glossary/${term.slug}`} className={surfaceCardClassName("interactive", "focus-ring block p-5")}>
              <div className="flex items-center gap-2">
                <BookOpen className="size-4 shrink-0 text-court" aria-hidden="true" />
                <h2 className="text-lg font-semibold leading-snug text-ink">{term.koreanTerm || term.term}</h2>
              </div>
              {term.koreanTerm ? <p className="mt-2 text-sm text-ink-subtle">{term.term}</p> : null}
              <p className="mt-3 line-clamp-3 text-[15px] leading-7 text-ink-muted">{term.definition}</p>
            </Link>
          ))}
        </div>
      )}
    </PageShell>
  );
}
