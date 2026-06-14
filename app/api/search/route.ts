import { NextResponse } from "next/server";
import { recordSearchEvent } from "@/lib/analytics/events";
import { listArticles } from "@/lib/db/queries";
import { semanticSearch, hybridSearch } from "@/lib/search/vector";
import { parseSearchApiParams, publicApiValidationErrorResponse } from "@/lib/security/public-api-validation";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const rateLimit = consumeRateLimit(request, "publicApi");
  if (rateLimit?.limited) {
    return rateLimitExceededResponse(rateLimit);
  }

  const { searchParams } = new URL(request.url);
  const parsed = parseSearchApiParams(searchParams);
  if (!parsed.ok) return publicApiValidationErrorResponse(parsed.error);

  const { filters, mode } = parsed.data;
  const result = mode === "semantic" ? await semanticSearch(filters) : mode === "hybrid" ? await hybridSearch(filters) : await listArticles(filters);
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
    },
  });

  return NextResponse.json({ ...result, mode });
}
