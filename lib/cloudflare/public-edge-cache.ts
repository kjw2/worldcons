/**
 * Public edge-cache policy for the crawlable archive surfaces.
 *
 * Cloudflare Workers do not cache a Worker-generated response just because it
 * carries `s-maxage`; the Worker must use the Cache API. This module owns the
 * request shape and key normalization so the cache can never serve a
 * personalized, admin, RSC or non-HTML response:
 *
 * - only `GET` requests for `/` and `/list`;
 * - no `authorization` or `cookie` (signed-in/admin) requests;
 * - no RSC/prefetch requests;
 * - query parameters that do not change the rendered document (`pageSize`,
 *   `view`, `sort`) are dropped and the remaining keys are sorted, so two
 *   equivalent URLs share one entry.
 *
 * Freshness is bounded by the response `cache-control` (`s-maxage=60`,
 * `stale-while-revalidate=300`). Publication-time `revalidateTag`/
 * `revalidatePath` still owns the Next data cache; the edge entry for the base
 * `/` and `/list` URLs is explicitly purged and every filtered variant ages out
 * within 60 seconds.
 */

export const PUBLIC_EDGE_CACHE_PATHS: ReadonlySet<string> = new Set(["/", "/list"]);

export const PUBLIC_EDGE_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

export const PUBLIC_EDGE_CACHE_STATUS_HEADER = "x-worldcons-edge-cache";

/** Query keys that do not affect the rendered public list/home document. */
const UNKEYED_QUERY_PARAMS = new Set(["pageSize", "view", "sort"]);

/** Headers that mark a React Server Component/prefetch request. */
const RSC_HEADERS = ["rsc", "next-router-prefetch", "next-router-state-tree", "x-middleware-prefetch"];

export interface EdgeCacheRequestLike {
  method: string;
  url: string;
  headers: { get(name: string): string | null };
}

/** Sorted, de-duplicated, unkeyed-parameter-free query string (no leading `?`). */
export function normalizedEdgeCacheSearch(search: string): string {
  const params = new URLSearchParams(search);
  const kept: Array<[string, string]> = [];
  for (const [key, value] of params) {
    if (UNKEYED_QUERY_PARAMS.has(key)) continue;
    kept.push([key, value]);
  }
  kept.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
  );
  return new URLSearchParams(kept).toString();
}

/** The canonical absolute cache key for an already-validated public request. */
export function edgeCacheKeyUrl(url: string): string {
  const parsed = new URL(url);
  const search = normalizedEdgeCacheSearch(parsed.search);
  return `${parsed.origin}${parsed.pathname}${search ? `?${search}` : ""}`;
}

/**
 * Whether a request may be served from, and stored in, the shared public edge
 * cache. Anything ambiguous fails closed: an uncached response is always safe.
 */
export function isEdgeCacheableRequest(request: EdgeCacheRequestLike): boolean {
  if (request.method !== "GET") return false;
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return false;
  }
  if (!PUBLIC_EDGE_CACHE_PATHS.has(parsed.pathname)) return false;
  if (request.headers.get("authorization")) return false;
  if (request.headers.get("cookie")) return false;
  if (request.headers.get("range")) return false;
  for (const header of RSC_HEADERS) {
    if (request.headers.get(header)) return false;
  }
  const accept = request.headers.get("accept");
  if (accept && !accept.includes("text/html") && !accept.includes("application/xhtml+xml") && !accept.includes("*/*")) {
    return false;
  }
  return true;
}

/** A response is cacheable only when it is a cookie-free, successful HTML page. */
export function isEdgeCacheableResponse(response: {
  status: number;
  headers: { get(name: string): string | null };
}): boolean {
  if (response.status !== 200) return false;
  if (response.headers.get("set-cookie")) return false;
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("text/html");
}
