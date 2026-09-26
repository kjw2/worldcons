import { crawlerUserAgent } from "@/lib/crawler/user-agents";
import type { CrawlRequest, CrawlResponse } from "@/lib/crawler/types";

interface BrowserRunResponse {
  schemaVersion: 1;
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  contentType?: string;
  html?: string;
  fetchedAt: string;
  diagnostics?: CrawlResponse["diagnostics"];
}

export function cloudflareBrowserRunConfigured(environment: Record<string, string | undefined> = process.env) {
  return Boolean(environment.CLOUDFLARE_BROWSER_RUN_URL?.trim() && environment.CLOUDFLARE_BROWSER_RUN_TOKEN?.trim());
}

export function cloudflareBrowserRunRequired(environment: Record<string, string | undefined> = process.env) {
  return environment.CLOUDFLARE_BROWSER_RUN_REQUIRED?.trim().toLowerCase() === "true";
}

function endpoint(environment: Record<string, string | undefined>) {
  const raw = environment.CLOUDFLARE_BROWSER_RUN_URL?.trim();
  if (!raw) throw new Error("CLOUDFLARE_BROWSER_RUN_URL is required");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("CLOUDFLARE_BROWSER_RUN_URL must be an HTTPS URL");
  url.pathname = "/v1/navigate";
  url.search = "";
  url.hash = "";
  return url;
}

function validResponse(value: unknown): value is BrowserRunResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<BrowserRunResponse>;
  return row.schemaVersion === 1
    && typeof row.url === "string"
    && typeof row.finalUrl === "string"
    && typeof row.status === "number"
    && typeof row.fetchedAt === "string"
    && Boolean(row.headers && typeof row.headers === "object" && !Array.isArray(row.headers));
}

export async function crawlWithCloudflareBrowserRun(
  request: CrawlRequest,
  environment: Record<string, string | undefined> = process.env,
): Promise<CrawlResponse> {
  const token = environment.CLOUDFLARE_BROWSER_RUN_TOKEN?.trim();
  if (!token) throw new Error("CLOUDFLARE_BROWSER_RUN_TOKEN is required");
  const timeoutMs = Math.min(60_000, Math.max(1_000, request.timeoutMs ?? 45_000));
  const timeout = AbortSignal.timeout(timeoutMs + 5_000);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const response = await fetch(endpoint(environment), {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      url: request.url,
      timeoutMs,
      waitUntil: request.waitUntil ?? "domcontentloaded",
      waitForSelector: request.waitForSelector,
      userAgent: crawlerUserAgent(),
    }),
    signal,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !validResponse(body)) {
    throw new Error(`Cloudflare Browser Run failed with HTTP ${response.status}`);
  }
  return {
    url: body.url,
    finalUrl: body.finalUrl,
    status: body.status,
    headers: body.headers,
    contentType: body.contentType,
    html: body.html,
    text: body.html,
    fetchedAt: body.fetchedAt,
    strategy: "playwright",
    diagnostics: body.diagnostics,
  };
}
