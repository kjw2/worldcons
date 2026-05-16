import { NextResponse } from "next/server";
import { isPublicClientEventType, recordSiteEvent } from "@/lib/analytics/events";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function textField(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function POST(request: Request) {
  const rateLimit = consumeRateLimit(request, "analyticsEvent");
  if (rateLimit?.limited) {
    return rateLimitExceededResponse(rateLimit);
  }

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const eventType = textField(body.eventType);

  if (!eventType || !isPublicClientEventType(eventType)) {
    return NextResponse.json({ error: "Unsupported analytics event" }, { status: 400 });
  }

  await recordSiteEvent(
    {
      eventType,
      path: textField(body.path),
      articleId: textField(body.articleId),
      articleSlug: textField(body.articleSlug),
      articleTitle: textField(body.articleTitle),
      tagSlug: textField(body.tagSlug),
      tagName: textField(body.tagName),
      sourceKey: textField(body.sourceKey),
      jurisdiction: textField(body.jurisdiction),
      institutionName: textField(body.institutionName),
      resultCount: numberField(body.resultCount),
      metadata: typeof body.metadata === "object" && body.metadata !== null && !Array.isArray(body.metadata) ? (body.metadata as Record<string, unknown>) : undefined,
    },
    request.headers,
  );

  return new NextResponse(null, { status: 204 });
}
