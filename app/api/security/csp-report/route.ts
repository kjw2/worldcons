import { NextResponse } from "next/server";
import { recordSiteEvent } from "@/lib/analytics/events";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_CSP_REPORT_BYTES = 16 * 1024;

function limitedText(value: unknown, max = 500) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportBody(payload: unknown) {
  if (Array.isArray(payload)) {
    const first = payload.find((item) => isRecord(item) && isRecord(item.body));
    return isRecord(first) && isRecord(first.body) ? first.body : null;
  }
  if (!isRecord(payload)) return null;
  const legacy = payload["csp-report"];
  if (isRecord(legacy)) return legacy;
  const body = payload.body;
  return isRecord(body) ? body : payload;
}

function pathFromDocumentUri(documentUri: string | null) {
  if (!documentUri) return "/api/security/csp-report";
  try {
    const url = new URL(documentUri);
    return `${url.pathname}${url.search}`.slice(0, 500) || "/";
  } catch {
    return "/api/security/csp-report";
  }
}

function cspMetadata(body: Record<string, unknown>) {
  return {
    kind: "csp_report",
    documentUri: limitedText(body["document-uri"] ?? body.documentURL, 500),
    referrer: limitedText(body.referrer, 300),
    blockedUri: limitedText(body["blocked-uri"] ?? body.blockedURL, 500),
    violatedDirective: limitedText(body["violated-directive"] ?? body.effectiveDirective, 160),
    effectiveDirective: limitedText(body["effective-directive"] ?? body.effectiveDirective, 160),
    originalPolicy: limitedText(body["original-policy"], 1000),
    disposition: limitedText(body.disposition, 40),
    sourceFile: limitedText(body["source-file"] ?? body.sourceFile, 500),
    statusCode: numberValue(body["status-code"] ?? body.statusCode),
    lineNumber: numberValue(body["line-number"] ?? body.lineNumber),
    columnNumber: numberValue(body["column-number"] ?? body.columnNumber),
    sample: limitedText(body.sample, 300),
  };
}

export async function POST(request: Request) {
  const rateLimit = consumeRateLimit(request, "cspReport");
  if (rateLimit?.limited) return rateLimitExceededResponse(rateLimit);

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_CSP_REPORT_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  const payload = await request.json().catch(() => null);
  const body = reportBody(payload);
  if (!body) return NextResponse.json({ error: "Invalid CSP report" }, { status: 400 });

  const metadata = cspMetadata(body);
  await recordSiteEvent(
    {
      eventType: "security_event",
      path: pathFromDocumentUri(metadata.documentUri),
      metadata,
    },
    request.headers,
  );

  return new NextResponse(null, { status: 204 });
}
