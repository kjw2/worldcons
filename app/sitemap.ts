import type { MetadataRoute } from "next";
import { listGlossaryTerms, listPublicSitemapArticles, listSources, listTags } from "@/lib/db/queries";
import { getAppBaseUrl, isIndexablePublicTag } from "@/lib/seo/metadata";
import { MIN_INDEXABLE_TAG_ARTICLE_COUNT } from "@/lib/seo/public-urls";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function resilientSitemapRead<T>(source: string, read: () => Promise<T[]>): Promise<T[]> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await read();
    } catch {
      if (attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      console.error(JSON.stringify({ event: "sitemap_source_unavailable", source }));
    }
  }
  return [];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = getAppBaseUrl();
  const [articles, sources, tags, glossary] = await Promise.all([
    resilientSitemapRead("articles", () => listPublicSitemapArticles()),
    resilientSitemapRead("sources", () => listSources()),
    resilientSitemapRead("tags", () => listTags({ sort: "count", minArticleCount: MIN_INDEXABLE_TAG_ARTICLE_COUNT })),
    resilientSitemapRead("glossary", () => listGlossaryTerms()),
  ]);

  return [
    { url: `${baseUrl}/`, changeFrequency: "hourly", priority: 1 },
    { url: `${baseUrl}/list`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${baseUrl}/tags`, changeFrequency: "daily", priority: 0.8 },
    { url: `${baseUrl}/sources`, changeFrequency: "weekly", priority: 0.5 },
    { url: `${baseUrl}/glossary`, changeFrequency: "weekly", priority: 0.5 },
    { url: `${baseUrl}/guide`, changeFrequency: "weekly", priority: 0.5 },
    ...sources
      .filter((source) => source.isActive)
      .map((source) => ({
        url: `${baseUrl}/sources/${source.sourceKey}`,
        changeFrequency: "weekly" as const,
        priority: 0.5,
      })),
    ...articles.map((article) => ({
      url: `${baseUrl}/articles/${article.slug}`,
      lastModified: article.lastModified || undefined,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
    ...tags.filter(isIndexablePublicTag).map((tag) => ({
      url: `${baseUrl}/tags/${tag.slug}`,
      lastModified: tag.latestArticleAt || undefined,
      changeFrequency: "daily" as const,
      priority: 0.6,
    })),
    ...glossary.map((term) => ({
      url: `${baseUrl}/glossary/${term.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.4,
    })),
  ];
}
