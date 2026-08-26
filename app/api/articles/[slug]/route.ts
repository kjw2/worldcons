import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";
import { PUBLIC_ARTICLES_CACHE_TAG } from "@/lib/public-content-cache";
import { getArticleBySlug } from "@/lib/db/queries";
import { parseSlugParam, publicApiValidationErrorResponse } from "@/lib/security/public-api-validation";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const getCachedArticle = unstable_cache(
  async (slug: string) => getArticleBySlug(slug),
  ["api-article-detail-v3"],
  { revalidate: 60, tags: [PUBLIC_ARTICLES_CACHE_TAG] },
);

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const rateLimit = await consumeRateLimit(request, "publicApi");
  if (rateLimit?.limited) {
    return rateLimitExceededResponse(rateLimit);
  }

  const { slug } = await params;
  const parsed = parseSlugParam(slug);
  if (!parsed.ok) return publicApiValidationErrorResponse(parsed.error);

  const article = await getCachedArticle(parsed.data);

  if (!article) {
    return NextResponse.json({ error: "Article not found" }, { status: 404 });
  }

  return NextResponse.json(article, {
    headers: {
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
