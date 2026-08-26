import { NextResponse } from "next/server";
import { recordSiteEvent } from "@/lib/analytics/events";
import { isProbablyOversizedJsonRequest, parseAnalyticsEventBody, publicApiValidationErrorResponse } from "@/lib/security/public-api-validation";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const revalidate = 0;
const MAX_ANALYTICS_EVENT_BYTES = 16 * 1024;

export async function POST(request: Request) {
  const rateLimit = await consumeRateLimit(request, "analyticsEvent");
  if (rateLimit?.limited) {
    return rateLimitExceededResponse(rateLimit);
  }

  if (isProbablyOversizedJsonRequest(request, MAX_ANALYTICS_EVENT_BYTES)) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  const body = await request.json().catch(() => null);
  const parsed = parseAnalyticsEventBody(body);
  if (!parsed.ok) return publicApiValidationErrorResponse(parsed.error);

  await recordSiteEvent(
    parsed.data,
    request.headers,
  );

  return new NextResponse(null, { status: 204 });
}
