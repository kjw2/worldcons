import { NextResponse } from "next/server";
import { listArticles } from "@/lib/db/queries";
import { parseArticleListApiParams, publicApiValidationErrorResponse } from "@/lib/security/public-api-validation";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const rateLimit = consumeRateLimit(request, "publicApi");
  if (rateLimit?.limited) {
    return rateLimitExceededResponse(rateLimit);
  }

  const { searchParams } = new URL(request.url);
  const parsed = parseArticleListApiParams(searchParams);
  if (!parsed.ok) return publicApiValidationErrorResponse(parsed.error);

  const result = await listArticles({ ...parsed.data, count: parsed.data.count ?? "estimated" });

  return NextResponse.json(result);
}
