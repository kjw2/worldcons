import { crawlerHeaders } from "@/lib/crawler/user-agents";
import { respectRateLimit } from "@/lib/crawler/rate-limit";
import { retryCount, retryDelayMs, withRetry } from "@/lib/crawler/retry";
import type { CrawlRequest, CrawlResponse } from "@/lib/crawler/types";

const DEFAULT_TIMEOUT_MS = 30_000;

function timeoutMs(request?: CrawlRequest) {
  return request?.timeoutMs ?? Number(process.env.CRAWLER_TIMEOUT_MS ?? process.env.INGEST_FETCH_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
}

function headersToRecord(headers: Headers) {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function statusDiagnostics(status: number, statusText?: string) {
  if (status === 403) return { blocked: true, errorCode: "HTTP_403", errorMessage: statusText || "Forbidden" };
  if (status === 404) return { errorCode: "HTTP_404", errorMessage: statusText || "Not Found" };
  if (status === 429) return { blocked: true, errorCode: "HTTP_429", errorMessage: statusText || "Too Many Requests" };
  if (status >= 500) return { errorCode: `HTTP_${status}`, errorMessage: statusText || "Server error" };
  if (status >= 400) return { errorCode: `HTTP_${status}`, errorMessage: statusText || "HTTP error" };
  return {};
}

function shouldRetryStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

async function fetchOnce(request: CrawlRequest): Promise<CrawlResponse> {
  await request.checkpoint?.();
  if (request.signal?.aborted) throw request.signal.reason;
  await respectRateLimit(request.url, request.rateLimitDelayMs);
  await request.checkpoint?.();

  const response = await fetch(request.url, {
    method: request.method ?? "GET",
    headers: crawlerHeaders(request.headers),
    redirect: "follow",
    signal: request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs(request))])
      : AbortSignal.timeout(timeoutMs(request)),
  });
  await request.checkpoint?.();
  const contentType = response.headers.get("content-type") ?? undefined;
  const headers = headersToRecord(response.headers);
  const diagnostics = {
    redirected: response.redirected,
    redirectChain: response.redirected ? [request.url, response.url] : undefined,
    ...statusDiagnostics(response.status, response.statusText),
  };
  const body = await response.arrayBuffer();
  await request.checkpoint?.();
  const buffer = Buffer.from(body);
  const isTextLike =
    !contentType ||
    contentType.includes("text/") ||
    contentType.includes("html") ||
    contentType.includes("xml") ||
    contentType.includes("json") ||
    contentType.includes("javascript");
  const text = isTextLike ? buffer.toString("utf8") : undefined;
  const html = contentType?.includes("html") ? text : undefined;

  return {
    url: request.url,
    finalUrl: response.url,
    status: response.status,
    contentType,
    html,
    text,
    buffer: contentType?.includes("pdf") || !isTextLike ? buffer : undefined,
    headers,
    fetchedAt: new Date().toISOString(),
    strategy: "fetch",
    diagnostics,
  };
}

export async function crawlUrl(request: CrawlRequest): Promise<CrawlResponse> {
  try {
    return await withRetry(
      async () => {
        const response = await fetchOnce(request);
        if (shouldRetryStatus(response.status)) {
          throw Object.assign(new Error(`${response.status} ${response.diagnostics?.errorMessage ?? "HTTP retryable status"}`), {
            response,
            retryable: true,
          });
        }
        return response;
      },
      {
        retries: retryCount(),
        delayMs: retryDelayMs(),
        shouldRetry: (error) =>
          !request.signal?.aborted
          && (Boolean((error as { retryable?: boolean }).retryable) || error instanceof DOMException),
      },
    );
  } catch (error) {
    if (request.signal?.aborted) throw request.signal.reason;
    const response = (error as { response?: CrawlResponse }).response;
    if (response) return response;

    const message = error instanceof Error ? error.message : String(error);
    const timeout = /timeout|aborted|AbortError/i.test(message);
    return {
      url: request.url,
      finalUrl: request.url,
      status: 0,
      headers: {},
      fetchedAt: new Date().toISOString(),
      strategy: "fetch",
      diagnostics: {
        timeout,
        timeoutPhase: timeout ? "response_header" : undefined,
        errorCode: timeout ? "TIMEOUT" : "FETCH_ERROR",
        errorMessage: message,
      },
    };
  }
}
