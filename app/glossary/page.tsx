import type { Metadata } from "next";
import Link from "next/link";
import { BookOpen } from "lucide-react";
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

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <p className="mb-2 text-sm font-semibold text-court">용어사전</p>
        <h1 className="text-3xl font-semibold tracking-normal text-ink">헌법재판 용어</h1>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {terms.map((term) => (
          <Link key={term.slug} href={`/glossary/${term.slug}`} className="focus-ring rounded-md border border-rule bg-white p-5 shadow-sm transition hover:shadow-soft">
            <div className="flex items-center gap-2">
              <BookOpen className="size-4 text-court" aria-hidden="true" />
              <h2 className="font-semibold">{term.koreanTerm || term.term}</h2>
            </div>
            <p className="mt-2 text-sm text-ink/62">{term.term}</p>
            <p className="mt-3 line-clamp-2 text-sm leading-6 text-ink/70">{term.definition}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
