import { NextResponse } from "next/server";
import { getSourceByKey, listArticles } from "@/lib/db/queries";
import { parseSourceKeyParam, publicApiValidationErrorResponse } from "@/lib/security/public-api-validation";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request, { params }: { params: Promise<{ sourceKey: string }> }) {
  const rateLimit = await consumeRateLimit(request, "publicApi");
  if (rateLimit?.limited) {
    return rateLimitExceededResponse(rateLimit);
  }

  const { sourceKey } = await params;
  const parsed = parseSourceKeyParam(sourceKey);
  if (!parsed.ok) return publicApiValidationErrorResponse(parsed.error);

  const source = await getSourceByKey(parsed.data);

  if (!source) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  const articles = await listArticles({ source: source.sourceKey, pageSize: 30 });
  return NextResponse.json({ source, articles });
}
