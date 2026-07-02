import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";
import { listArticles, listJurisdictionArticleCounts, listSources } from "@/lib/db/queries";
import type { ArticleListFilters, ArticleListResult } from "@/lib/db/types";
import { parseArticleListApiParams, publicApiValidationErrorResponse } from "@/lib/security/public-api-validation";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";

export const revalidate = 60;

function canUseJurisdictionTotal(filters: ArticleListFilters) {
  return !filters.q && !filters.source && !filters.jurisdiction && !filters.type && !filters.tag && !filters.language;
}

function withJurisdictionTotal(articles: ArticleListResult, jurisdictionArticleCounts: Record<string, number>) {
  const total = Math.max(
    articles.items.length,
    Object.values(jurisdictionArticleCounts).reduce((sum, count) => sum + count, 0),
  );

  return {
    ...articles,
    pageInfo: {
      ...articles.pageInfo,
      total,
      hasMore: articles.items.length < total,
      totalIsExact: true,
    },
  };
}

const getHomeRangePayload = unstable_cache(
  async (filters: ArticleListFilters) => {
    const sources = await listSources();
    const jurisdictions = Array.from(new Set(sources.map((source) => source.jurisdiction)));
    const countFromJurisdictions = canUseJurisdictionTotal(filters);
    const [articles, jurisdictionArticleCounts] = await Promise.all([
      listArticles({ ...filters, page: 1, count: countFromJurisdictions ? "none" : "exact" }),
      listJurisdictionArticleCounts(jurisdictions, { range: filters.range }),
    ]);

    return {
      articles: countFromJurisdictions ? withJurisdictionTotal(articles, jurisdictionArticleCounts) : articles,
      jurisdictionArticleCounts,
    };
  },
  ["home-range-payload-v1"],
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

  const payload = await getHomeRangePayload({
    ...parsed.data,
    page: 1,
    pageSize: parsed.data.pageSize ?? 9,
    count: "exact",
  });

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
