import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ArticleGrid } from "@/components/article-grid";
import { TagPill } from "@/components/tag-pill";
import { MetaRow } from "@/components/ui/meta-row";
import { PageShell } from "@/components/ui/page-shell";
import { SurfaceCard } from "@/components/ui/surface-card";
import { recordSiteEvent } from "@/lib/analytics/events";
import { getTagBySlug, listTags } from "@/lib/db/queries";
import { tagMetadata } from "@/lib/seo/metadata";
import { formatDisplayDate } from "@/lib/utils/dates";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const result = await getTagBySlug(slug);
  if (!result) return {};
  return tagMetadata(result.tag);
}

export default async function TagDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await getTagBySlug(slug);
  if (!result) notFound();
  const relatedTags = (await listTags({ sort: "latest" })).filter((tag) => tag.slug !== result.tag.slug).slice(0, 8);
  await recordSiteEvent(
    {
      eventType: "tag_view",
      path: `/tags/${result.tag.slug}`,
      tagSlug: result.tag.slug,
      tagName: result.tag.name,
      resultCount: result.articles.length,
    },
    await headers(),
  );

  return (
    <PageShell>
      <SurfaceCard className="mb-6 p-6">
        <p className="mb-2 text-sm font-semibold text-court">{result.tag.type}</p>
        <h1 className="text-3xl font-semibold tracking-normal text-ink sm:text-4xl">{result.tag.name}</h1>
        <MetaRow
          className="mt-3"
          items={[
            `누적 자료 ${(result.tag.articleCount ?? result.articles.length).toLocaleString("ko-KR")}건`,
            `최근 업데이트 ${formatDisplayDate(result.tag.latestArticleAt)}`,
          ]}
        />
        <div className="mt-5 flex flex-wrap gap-2">
          {relatedTags.map((tag) => (
            <TagPill key={tag.slug} tag={tag} />
          ))}
        </div>
      </SurfaceCard>
      <ArticleGrid articles={result.articles} />
    </PageShell>
  );
}
