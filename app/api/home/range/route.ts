import { unstable_cache as plainUnstableCache } from "next/cache";
import { freshnessAwarePublicCache as unstable_cache } from "@/lib/public-freshness-cache";
import { NextResponse } from "next/server";
import { PUBLIC_ARTICLES_CACHE_TAG, PUBLIC_ARTICLE_COUNTS_CACHE_TAG } from "@/lib/public-content-cache";
import { listArticles, listJurisdictionArticleCounts, publicArticleListCountMode } from "@/lib/db/queries";
import type { ArticleListFilters, ArticleListResult } from "@/lib/db/types";
import { parseArticleListApiParams, publicApiValidationErrorResponse } from "@/lib/security/public-api-validation";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";

export const revalidate = 60;

// Jurisdiction counts are public filter metadata, not article content and not
// an approval state. Keep them on the same plain cache policy the crawlable
// /list filter panel already uses: while the E2E generation tables exist the
// surrounding payload deliberately bypasses the content cache, but the full
// jurisdiction aggregate does not need to rerun on every range request.
const getHomeRangeJurisdictionCounts = plainUnstableCache(
  async (range: ArticleListFilters["range"]) => listJurisdictionArticleCounts([], { range }),
  ["home-range-jurisdiction-counts-v1"],
  { revalidate: 60, tags: [PUBLIC_ARTICLE_COUNTS_CACHE_TAG] },
);

function canUseJurisdictionTotal(filters: ArticleListFilters) {
  return publicArticleListCountMode(filters) === "none";
}

function withJurisdictionTotal(articles: ArticleListResult, jurisdictionArticleCounts: Record<string, number>, filters: ArticleListFilters) {
  const total = Math.max(
    articles.items.length,
    filters.jurisdiction
      ? jurisdictionArticleCounts[filters.jurisdiction] ?? 0
      : Object.values(jurisdictionArticleCounts).reduce((sum, count) => sum + count, 0),
  );
  const shownThrough = (articles.pageInfo.page - 1) * articles.pageInfo.pageSize + articles.items.length;

  return {
    ...articles,
    pageInfo: {
      ...articles.pageInfo,
      total: Math.max(total, shownThrough),
      hasMore: shownThrough < total,
      totalIsExact: true,
    },
  };
}

const getHomeRangePayload = unstable_cache(
  async (filters: ArticleListFilters) => {
    const countFromJurisdictions = canUseJurisdictionTotal(filters);
    const [articles, jurisdictionArticleCounts] = await Promise.all([
      // Narrow filters stay on the bounded fast path; only the explicit
      // `/api/articles?count=exact` surface may request a full exact count.
      listArticles({ ...filters, count: "none" }),
      getHomeRangeJurisdictionCounts(filters.range),
    ]);

    return {
      articles: countFromJurisdictions ? withJurisdictionTotal(articles, jurisdictionArticleCounts, filters) : articles,
      jurisdictionArticleCounts,
    };
  },
  ["home-range-payload-v2"],
  { revalidate: 60, tags: [PUBLIC_ARTICLES_CACHE_TAG, PUBLIC_ARTICLE_COUNTS_CACHE_TAG] },
);

export async function GET(request: Request) {
  const rateLimit = await consumeRateLimit(request, "publicApi");
  if (rateLimit?.limited) {
    return rateLimitExceededResponse(rateLimit);
  }

  const { searchParams } = new URL(request.url);
  const parsed = parseArticleListApiParams(searchParams);
  if (!parsed.ok) return publicApiValidationErrorResponse(parsed.error);

  const payload = await getHomeRangePayload({
    ...parsed.data,
    page: parsed.data.page ?? 1,
    pageSize: parsed.data.pageSize ?? 9,
  });

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
