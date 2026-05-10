import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArticleGrid } from "@/components/article-grid";
import { getSourceByKey, listArticles } from "@/lib/db/queries";
import { getAppBaseUrl } from "@/lib/seo/metadata";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata({ params }: { params: Promise<{ sourceKey: string }> }): Promise<Metadata> {
  const { sourceKey } = await params;
  const source = await getSourceByKey(sourceKey);
  if (!source) return {};
  return {
    title: source.name,
    description: `${source.jurisdiction} 공식 헌법재판 자료 수집 소스`,
    alternates: { canonical: `${getAppBaseUrl()}/sources/${source.sourceKey}` },
  };
}

export default async function SourceDetailPage({ params }: { params: Promise<{ sourceKey: string }> }) {
  const { sourceKey } = await params;
  const source = await getSourceByKey(sourceKey);
  if (!source) notFound();
  const articles = await listArticles({ source: source.sourceKey, pageSize: 30 });

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 rounded-md border border-rule bg-white p-5 shadow-sm">
        <p className="mb-2 text-sm font-semibold text-court">{source.jurisdiction}</p>
        <h1 className="text-3xl font-semibold tracking-normal text-ink">{source.name}</h1>
        <p className="mt-3 text-sm text-ink/62">
          {source.baseUrl} · {source.language} · {source.isActive ? "active" : "inactive"}
        </p>
      </div>
      <ArticleGrid articles={articles.items} />
    </main>
  );
}
