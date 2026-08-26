import { NextResponse } from "next/server";
import { recordSiteEvent } from "@/lib/analytics/events";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_CSP_REPORT_BYTES = 16 * 1024;
const SENSITIVE_QUERY_KEYS = /^(?:secret|token|key|api_key|apikey|access_token|refresh_token|password|code)$/i;

function redactSensitiveText(value: string) {
  return value
    .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, "$1[redacted]")
    .replace(/([?&](?:secret|token|key|api_key|apikey|access_token|refresh_token|password|code)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
}

function redactUrl(value: string) {
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return redactSensitiveText(url.toString());
  } catch {
    return redactSensitiveText(value);
  }
}

function limitedText(value: unknown, max = 500) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const redacted = redactSensitiveText(text);
  return redacted.length > max ? redacted.slice(0, max) : redacted;
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
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return redactSensitiveText(`${url.pathname}${url.search}`).slice(0, 500) || "/";
  } catch {
    return "/api/security/csp-report";
  }
}

function cspMetadata(body: Record<string, unknown>) {
  return {
    kind: "csp_report",
    documentUri: typeof (body["document-uri"] ?? body.documentURL) === "string" ? limitedText(redactUrl(String(body["document-uri"] ?? body.documentURL)), 500) : null,
    referrer: limitedText(body.referrer, 300),
    blockedUri: typeof (body["blocked-uri"] ?? body.blockedURL) === "string" ? limitedText(redactUrl(String(body["blocked-uri"] ?? body.blockedURL)), 500) : null,
    violatedDirective: limitedText(body["violated-directive"] ?? body.effectiveDirective, 160),
    effectiveDirective: limitedText(body["effective-directive"] ?? body.effectiveDirective, 160),
    originalPolicy: limitedText(body["original-policy"], 1000),
    disposition: limitedText(body.disposition, 40),
    sourceFile: typeof (body["source-file"] ?? body.sourceFile) === "string" ? limitedText(redactUrl(String(body["source-file"] ?? body.sourceFile)), 500) : null,
    statusCode: numberValue(body["status-code"] ?? body.statusCode),
    lineNumber: numberValue(body["line-number"] ?? body.lineNumber),
    columnNumber: numberValue(body["column-number"] ?? body.columnNumber),
    sample: limitedText(body.sample, 300),
  };
}

async function readLimitedRequestText(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_CSP_REPORT_BYTES) return null;
    chunks.push(value);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function POST(request: Request) {
  const rateLimit = await consumeRateLimit(request, "cspReport");
  if (rateLimit?.limited) return rateLimitExceededResponse(rateLimit);

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_CSP_REPORT_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  const text = await readLimitedRequestText(request);
  if (text === null) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  let payload: unknown = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Invalid CSP report" }, { status: 400 });
    }
  }
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
