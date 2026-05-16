import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ArticleGrid } from "@/components/article-grid";
import { TagPill } from "@/components/tag-pill";
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
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 rounded-md border border-rule bg-white p-5 shadow-sm">
        <p className="mb-2 text-sm font-semibold text-court">{result.tag.type}</p>
        <h1 className="text-3xl font-semibold tracking-normal text-ink">{result.tag.name}</h1>
        <p className="mt-3 text-sm text-ink/62">
          누적 기사 {result.tag.articleCount ?? result.articles.length}건 · 최근 업데이트 {formatDisplayDate(result.tag.latestArticleAt)}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {relatedTags.map((tag) => (
            <TagPill key={tag.slug} tag={tag} />
          ))}
        </div>
      </div>
      <ArticleGrid articles={result.articles} />
    </main>
  );
}
