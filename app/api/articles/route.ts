import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";
import { listArticles } from "@/lib/db/queries";
import type { ArticleListFilters } from "@/lib/db/types";
import { parseArticleListApiParams, publicApiValidationErrorResponse } from "@/lib/security/public-api-validation";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const getCachedArticleList = unstable_cache(
  async (filters: ArticleListFilters) => listArticles(filters),
  ["api-articles-v1"],
  { revalidate: 60 },
);

export async function GET(request: Request) {
  const rateLimit = consumeRateLimit(request, "publicApi");
  if (rateLimit?.limited) {
    return rateLimitExceededResponse(rateLimit);
  }

  const { searchParams } = new URL(request.url);
  const parsed = parseArticleListApiParams(searchParams);
  if (!parsed.ok) return publicApiValidationErrorResponse(parsed.error);

  const result = await getCachedArticleList({ ...parsed.data, count: parsed.data.count ?? "exact" });

  return NextResponse.json(result, {
    headers: {
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
