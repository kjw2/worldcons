import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TagPill } from "@/components/tag-pill";
import { MetaRow } from "@/components/ui/meta-row";
import { PageShell } from "@/components/ui/page-shell";
import { SurfaceCard } from "@/components/ui/surface-card";
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
    <PageShell className="max-w-4xl">
      <SurfaceCard className="p-6">
        <p className="mb-2 text-sm font-semibold text-court">{term.jurisdiction ?? "Common"}</p>
        <h1 className="text-3xl font-semibold tracking-normal text-ink sm:text-4xl">{term.koreanTerm || term.term}</h1>
        {term.koreanTerm ? <MetaRow className="mt-3" items={[term.term]} /> : null}
        <p className="mt-6 text-base leading-8 text-ink-muted">{term.definition}</p>
        {term.relatedTags.length > 0 ? (
          <div className="mt-7 border-t border-line pt-5">
            <h2 className="mb-3 text-base font-semibold text-ink">관련 태그</h2>
            <div className="flex flex-wrap gap-2">
              {term.relatedTags.map((tag) => {
                const normalized = normalizeTagForStorage(tag);
                return <TagPill key={normalized.slug} tag={{ slug: normalized.slug, name: normalized.name, type: "topic" }} />;
              })}
            </div>
          </div>
        ) : null}
      </SurfaceCard>
    </PageShell>
  );
}
