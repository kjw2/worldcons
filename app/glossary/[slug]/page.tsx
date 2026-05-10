import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TagPill } from "@/components/tag-pill";
import { getGlossaryTerm } from "@/lib/db/queries";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { normalizeTagForStorage } from "@/lib/ai/tags";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const term = await getGlossaryTerm(slug);
  if (!term) return {};
  const title = `${term.koreanTerm || term.term} 용어 설명`;
  return {
    title,
    description: term.definition,
    alternates: { canonical: `${getAppBaseUrl()}/glossary/${term.slug}` },
  };
}

export default async function GlossaryDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const term = await getGlossaryTerm(slug);
  if (!term) notFound();

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <article className="rounded-md border border-rule bg-white p-6 shadow-sm">
        <p className="mb-2 text-sm font-semibold text-court">{term.jurisdiction ?? "Common"}</p>
        <h1 className="text-3xl font-semibold tracking-normal text-ink">{term.koreanTerm || term.term}</h1>
        {term.koreanTerm ? <p className="mt-2 text-sm text-ink/58">{term.term}</p> : null}
        <p className="mt-6 text-sm leading-7 text-ink/74">{term.definition}</p>
        <div className="mt-6 flex flex-wrap gap-2">
          {term.relatedTags.map((tag) => {
            const normalized = normalizeTagForStorage(tag);
            return <TagPill key={normalized.slug} tag={{ slug: normalized.slug, name: normalized.name, type: "topic" }} />;
          })}
        </div>
      </article>
    </main>
  );
}
