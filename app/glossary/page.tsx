import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { BookOpen } from "lucide-react";
import { SearchBox } from "@/components/search-box";
import { chipClassName } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { MetaRow } from "@/components/ui/meta-row";
import { PageShell } from "@/components/ui/page-shell";
import { SectionHeading } from "@/components/ui/section-heading";
import { surfaceCardClassName } from "@/components/ui/surface-card";
import { recordSiteEvent } from "@/lib/analytics/events";
import { listGlossaryTerms } from "@/lib/db/queries";
import { glossaryJurisdictionLabel, glossarySourceLanguageLabel } from "@/lib/glossary/languages";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "헌법재판 용어사전",
  description: "헌법재판 관련 권리, 절차, 원칙, 국가별 제도 용어를 정리합니다.",
  alternates: { canonical: `${getAppBaseUrl()}/glossary` },
};

const languageFilters = [
  { value: "", label: "전체" },
  { value: "common", label: "공통" },
  { value: "de", label: "독일어" },
  { value: "en", label: "영어" },
  { value: "fr", label: "프랑스어" },
];

function languageMatches(jurisdiction: string | null | undefined, language: string) {
  if (!language) return true;
  if (language === "common") return !jurisdiction;
  if (language === "de") return jurisdiction === "Germany";
  if (language === "en") return jurisdiction === "United States";
  if (language === "fr") return jurisdiction === "France";
  return true;
}

function termMatchesQuery(term: Awaited<ReturnType<typeof listGlossaryTerms>>[number], q?: string) {
  if (!q) return true;
  const needles = q.toLowerCase().split(/\s+/).map((item) => item.trim()).filter(Boolean);
  const haystack = [term.term, term.koreanTerm, term.definition, term.jurisdiction, ...term.relatedTags].filter(Boolean).join(" ").toLowerCase();
  return needles.every((needle) => haystack.includes(needle));
}

function hrefForLanguage(q: string | undefined, language: string) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (language) params.set("language", language);
  const query = params.toString();
  return query ? `/glossary?${query}` : "/glossary";
}

export default async function GlossaryPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const params = await resolveSearchParams(searchParams);
  const q = getSearchParam(params, "q")?.trim();
  const language = getSearchParam(params, "language") ?? "";
  const terms = await listGlossaryTerms();
  const filteredTerms = terms.filter((term) => languageMatches(term.jurisdiction, language)).filter((term) => termMatchesQuery(term, q));
  await recordSiteEvent(
    {
      eventType: "page_view",
      path: "/glossary",
      resultCount: filteredTerms.length,
      metadata: { q, language },
    },
    await headers(),
  );

  return (
    <PageShell>
      <SectionHeading
        className="mb-6"
        eyebrow="용어사전"
        title="헌법재판 용어"
        description="권리, 절차, 심사 기준, 국가별 제도 용어를 짧은 설명과 관련 태그로 확인합니다. AI가 생성한 설명과 태그이므로 부정확할 수 있으니 반드시 확인하시기 바랍니다."
      />
      <div className="mb-5 rounded-lg border border-line bg-white p-4 shadow-card">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            {languageFilters.map((filter) => (
              <Link key={filter.value || "all"} href={hrefForLanguage(q, filter.value)} className={chipClassName(language === filter.value ? "selected" : "default")}>
                {filter.label}
              </Link>
            ))}
          </div>
          <div className="w-full lg:max-w-md">
            <SearchBox
              defaultValue={q}
              action="/glossary"
              placeholder="용어, 원어, 관련 태그 검색"
              hiddenFields={language ? [["language", language]] : []}
            />
          </div>
        </div>
      </div>
      {filteredTerms.length === 0 ? (
        <EmptyState title="조건에 맞는 용어가 없습니다" description="검색어를 줄이거나 출처 언어 필터를 바꾸면 더 많은 용어를 확인할 수 있습니다." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filteredTerms.map((term) => (
            <Link key={term.slug} href={`/glossary/${term.slug}`} className={surfaceCardClassName("interactive", "focus-ring block p-5")}>
              <div className="flex items-center gap-2">
                <BookOpen className="size-4 shrink-0 text-court" aria-hidden="true" />
                <h2 className="text-lg font-semibold leading-snug text-ink">{term.koreanTerm || term.term}</h2>
              </div>
              <MetaRow className="mt-2" items={[term.koreanTerm ? term.term : null, glossaryJurisdictionLabel(term), `출처 언어: ${glossarySourceLanguageLabel(term)}`]} />
              <p className="mt-3 line-clamp-3 text-[15px] leading-7 text-ink-muted">{term.definition}</p>
              {term.relatedTags.length > 0 ? (
                <p className="mt-3 line-clamp-1 text-xs font-medium text-ink-subtle">
                  {term.relatedTags.slice(0, 3).join(" · ")}
                  {term.relatedTags.length > 3 ? ` +${term.relatedTags.length - 3}` : ""}
                </p>
              ) : null}
            </Link>
          ))}
        </div>
      )}
    </PageShell>
  );
}
