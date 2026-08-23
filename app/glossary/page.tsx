import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { SearchBox } from "@/components/search-box";
import { EmptyState } from "@/components/ui/empty-state";
import { PageShell } from "@/components/ui/page-shell";
import { recordSiteEvent } from "@/lib/analytics/events";
import { listGlossaryTerms } from "@/lib/db/queries";
import { glossaryJurisdictionLabel, glossarySourceLanguageLabel } from "@/lib/glossary/languages";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "헌법 용어집",
  description: "헌법재판 관련 권리, 절차, 원칙, 국가별 제도 용어를 찾아봅니다.",
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

  await recordSiteEvent({ eventType: "page_view", path: "/glossary", resultCount: filteredTerms.length, metadata: { q, language } }, await headers());

  return (
    <PageShell className="max-w-[1248px] py-6 sm:py-8">
      <header className="mb-7 border-b border-archive-line-strong pb-6">
        <p className="text-sm font-bold text-archive-accent">용어집</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-[-0.03em] text-archive-ink">헌법재판 용어</h1>
        <p className="mt-3 max-w-3xl text-[15px] leading-7 text-archive-text">국가별 헌법재판 제도와 권리·절차·법리를 한국어와 원어 기준으로 찾아볼 수 있습니다.</p>
      </header>

      <section className="mb-8 border-t-2 border-archive-accent border-b border-archive-line-strong py-4" aria-label="용어 검색 및 필터">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-semibold" aria-label="출처 언어">
            {languageFilters.map((filter) => (
              <Link key={filter.value || "all"} href={hrefForLanguage(q, filter.value)} aria-current={language === filter.value ? "page" : undefined} className={language === filter.value ? "text-archive-accent underline decoration-2 underline-offset-8" : "text-archive-text hover:text-archive-accent"}>
                {filter.label}
              </Link>
            ))}
          </nav>
          <div className="w-full lg:max-w-md">
            <SearchBox defaultValue={q} action="/glossary" placeholder="용어, 원어, 관련 태그 검색" hiddenFields={language ? [["language", language]] : []} />
          </div>
        </div>
      </section>

      <div className="mb-3 flex items-end justify-between gap-4">
        <h2 className="text-lg font-bold text-archive-heading">용어 목록</h2>
        <p className="text-sm text-archive-muted">총 {filteredTerms.length.toLocaleString("ko-KR")}건</p>
      </div>

      {filteredTerms.length === 0 ? (
        <EmptyState title="조건에 맞는 용어가 없습니다" description="검색어를 줄이거나 출처 언어 필터를 바꾸면 더 많은 용어를 확인할 수 있습니다." />
      ) : (
        <div className="border-t border-archive-line-strong">
          {filteredTerms.map((term) => (
            <Link key={term.slug} href={`/glossary/${term.slug}`} className="focus-ring grid gap-2 border-b border-archive-line py-5 hover:bg-archive-surface-soft sm:grid-cols-[220px_minmax(0,1fr)] sm:gap-6 sm:px-2">
              <div>
                <h3 className="text-[17px] font-bold leading-6 text-archive-heading">{term.koreanTerm || term.term}</h3>
                {term.koreanTerm ? <p className="mt-1 text-sm text-archive-muted">{term.term}</p> : null}
                <p className="mt-2 text-xs text-archive-subtle">{glossaryJurisdictionLabel(term)} · {glossarySourceLanguageLabel(term)}</p>
              </div>
              <div>
                <p className="line-clamp-3 text-[15px] leading-7 text-archive-text">{term.definition}</p>
                {term.relatedTags.length > 0 ? <p className="mt-2 text-xs text-archive-muted">관련 쟁점 {term.relatedTags.slice(0, 4).join(" · ")}</p> : null}
              </div>
            </Link>
          ))}
        </div>
      )}
    </PageShell>
  );
}
