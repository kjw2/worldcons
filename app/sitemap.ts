import type { MetadataRoute } from "next";
import { listArticles, listGlossaryTerms, listSources, listTags } from "@/lib/db/queries";
import { getAppBaseUrl } from "@/lib/seo/metadata";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = getAppBaseUrl();
  const [articles, sources, tags, glossary] = await Promise.all([
    listArticles({ pageSize: 1000 }),
    listSources(),
    listTags({ sort: "count" }),
    listGlossaryTerms(),
  ]);

  return [
    { url: `${baseUrl}/`, changeFrequency: "hourly", priority: 1 },
    { url: `${baseUrl}/list`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${baseUrl}/search`, changeFrequency: "daily", priority: 0.7 },
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
    ...articles.items.map((article) => ({
      url: `${baseUrl}/articles/${article.slug}`,
      lastModified: article.summarizedAt || article.fetchedAt || article.discoveredAt || undefined,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
    ...tags.map((tag) => ({
      url: `${baseUrl}/tags/${tag.slug}`,
      lastModified: tag.latestArticleAt || undefined,
      changeFrequency: "daily" as const,
      priority: 0.7,
    })),
    ...glossary.map((term) => ({
      url: `${baseUrl}/glossary/${term.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.4,
    })),
  ];
}
