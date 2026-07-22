import { revalidatePath, revalidateTag } from "next/cache";

export const PUBLIC_ARTICLES_CACHE_TAG = "public-articles-v1";
export const PUBLIC_ARTICLE_COUNTS_CACHE_TAG = "public-article-counts-v1";
export const PUBLIC_TAGS_CACHE_TAG = "public-tags-v1";
export const PUBLIC_PORTAL_CACHE_TAG = "public-portal-v1";

export const PUBLIC_CONTENT_CACHE_TAGS = [
  PUBLIC_ARTICLES_CACHE_TAG,
  PUBLIC_ARTICLE_COUNTS_CACHE_TAG,
  PUBLIC_TAGS_CACHE_TAG,
  PUBLIC_PORTAL_CACHE_TAG,
] as const;

const PUBLIC_CONTENT_PATHS = [
  "/",
  "/v2",
  "/list",
  "/v2/list",
  "/api/articles",
  "/api/home/range",
  "/api/portal/latest",
  "/api/portal/latest-by-country",
  "/rss.xml",
  "/sitemap.xml",
] as const;

function validArticleSlug(value?: string | null) {
  const slug = value?.trim();
  return slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(slug) ? slug : null;
}

export function invalidatePublicContentCaches(options: { articleSlug?: string | null } = {}) {
  for (const tag of PUBLIC_CONTENT_CACHE_TAGS) {
    revalidateTag(tag);
  }

  for (const path of PUBLIC_CONTENT_PATHS) {
    revalidatePath(path);
  }
  revalidatePath("/articles/[slug]", "page");
  revalidatePath("/articles/[slug]/print", "page");
  revalidatePath("/v2/articles/[slug]", "page");
  revalidatePath("/v2/articles/[slug]/print", "page");

  const articleSlug = validArticleSlug(options.articleSlug);
  const articlePaths = articleSlug
    ? [
        `/articles/${articleSlug}`,
        `/articles/${articleSlug}/print`,
        `/v2/articles/${articleSlug}`,
        `/v2/articles/${articleSlug}/print`,
        `/api/articles/${articleSlug}`,
        `/api/articles/${articleSlug}/source-text`,
      ]
    : [];
  for (const path of articlePaths) {
    revalidatePath(path);
  }

  return {
    revalidated: true as const,
    tags: [...PUBLIC_CONTENT_CACHE_TAGS],
    paths: [
      ...PUBLIC_CONTENT_PATHS,
      "/articles/[slug]",
      "/articles/[slug]/print",
      "/v2/articles/[slug]",
      "/v2/articles/[slug]/print",
      ...articlePaths,
    ],
  };
}
