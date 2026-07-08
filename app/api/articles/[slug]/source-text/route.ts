import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";
import { getArticleSourceTextBySlug } from "@/lib/db/queries";
import { parseSlugParam, publicApiValidationErrorResponse } from "@/lib/security/public-api-validation";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const getCachedArticleSourceText = unstable_cache(
  async (slug: string) => getArticleSourceTextBySlug(slug),
  ["api-article-source-text-v1"],
  { revalidate: 300 },
);

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const rateLimit = consumeRateLimit(request, "publicApi");
  if (rateLimit?.limited) {
    return rateLimitExceededResponse(rateLimit);
  }

  const { slug } = await params;
  const parsed = parseSlugParam(slug);
  if (!parsed.ok) return publicApiValidationErrorResponse(parsed.error);

  const snapshot = await getCachedArticleSourceText(parsed.data);
  if (!snapshot?.cleanedText) {
    return NextResponse.json({ error: "Source snapshot not found" }, { status: 404 });
  }

  return NextResponse.json({
    slug: snapshot.slug,
    cleanedText: snapshot.cleanedText,
  }, {
    headers: {
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
