import { NextResponse } from "next/server";
import { recordSearchEvent } from "@/lib/analytics/events";
import { listArticles } from "@/lib/db/queries";
import { semanticSearch, hybridSearch } from "@/lib/search/vector";
import { parseSearchApiParams, publicApiValidationErrorResponse } from "@/lib/security/public-api-validation";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { mapSearchApiArticle, WORLDCONS_SEARCH_SCHEMA_VERSION } from "@/lib/search/api-contract";
import { caseCatalogSearchEnabled } from "@/lib/case-catalog/flags";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const rateLimit = await consumeRateLimit(request, "publicApi");
  if (rateLimit?.limited) {
    return rateLimitExceededResponse(rateLimit);
  }

  const { searchParams } = new URL(request.url);
  const parsed = parseSearchApiParams(searchParams);
  if (!parsed.ok) return publicApiValidationErrorResponse(parsed.error);

  const { filters, mode } = parsed.data;
  const catalogSearch = caseCatalogSearchEnabled();
  if (filters.cursor && (!catalogSearch || mode === "semantic")) {
    return publicApiValidationErrorResponse("cursor: cursor pagination is available only for Catalog lexical or hybrid search");
  }
  if (catalogSearch && mode !== "semantic" && (filters.page ?? 1) > 1 && !filters.cursor) {
    return publicApiValidationErrorResponse("cursor: a nextCursor from the previous Catalog search page is required");
  }
  try {
    const result =
      mode === "semantic"
        ? await semanticSearch(filters)
        : mode === "hybrid"
          ? await hybridSearch(filters)
          : await listArticles(filters);
    await recordSearchEvent({
      query: filters.q,
      mode,
      resultCount: result.pageInfo.total,
      path: "/api/search",
      headers: request.headers,
      metadata: {
        source: filters.source,
        jurisdiction: filters.jurisdiction,
        tag: filters.tag,
        language: filters.language,
        type: filters.type,
        page: filters.page,
        cursor: Boolean(filters.cursor),
      },
    });

    return NextResponse.json(
      {
        schemaVersion: WORLDCONS_SEARCH_SCHEMA_VERSION,
        service: "worldcons",
        ...result,
        items: result.items.map((item) => mapSearchApiArticle(item, getAppBaseUrl())),
        mode,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    console.error("[search-api] search unavailable", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json(
      {
        schemaVersion: WORLDCONS_SEARCH_SCHEMA_VERSION,
        service: "worldcons",
        error: "Search temporarily unavailable",
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": "30",
        },
      },
    );
  }
}
