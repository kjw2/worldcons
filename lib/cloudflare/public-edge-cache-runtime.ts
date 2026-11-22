import {
  PUBLIC_EDGE_CACHE_CONTROL,
  PUBLIC_EDGE_CACHE_STATUS_HEADER,
  edgeCacheKeyUrl,
  isEdgeCacheableRequest,
  isEdgeCacheableResponse,
  type EdgeCacheRequestLike,
} from "@/lib/cloudflare/public-edge-cache";

/**
 * Cache API orchestration for the public archive surfaces. The storage is
 * injected (the Worker passes `caches.default`) so the flow can be unit-tested
 * without a live edge.
 */
export interface EdgeCacheStorage {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface EdgeCacheResult {
  response: Response;
  status: "HIT" | "MISS" | "BYPASS";
  key: string | null;
}

function cachedResponse(cached: Response): Response {
  const headers = new Headers(cached.headers);
  headers.set(PUBLIC_EDGE_CACHE_STATUS_HEADER, "HIT");
  return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
}

function markedResponse(response: Response, status: "MISS" | "BYPASS"): Response {
  const headers = new Headers(response.headers);
  headers.set(PUBLIC_EDGE_CACHE_STATUS_HEADER, status);
  if (status === "MISS") headers.set("cache-control", PUBLIC_EDGE_CACHE_CONTROL);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function storedResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", PUBLIC_EDGE_CACHE_CONTROL);
  headers.set(PUBLIC_EDGE_CACHE_STATUS_HEADER, "MISS");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Serves a public document through the edge cache. Personal/admin/RSC/non-HTML
 * requests and responses bypass the cache entirely. A cache failure never
 * changes the response: it degrades to a normal origin render.
 */
export async function serveWithEdgeCache(options: {
  request: EdgeCacheRequestLike;
  cache: EdgeCacheStorage | null;
  fetchOrigin: () => Promise<Response>;
  waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<EdgeCacheResult> {
  const { request, cache, fetchOrigin } = options;
  if (!cache || !isEdgeCacheableRequest(request)) {
    return { response: await fetchOrigin(), status: "BYPASS", key: null };
  }

  const key = edgeCacheKeyUrl(request.url);
  try {
    const cached = await cache.match(key);
    if (cached) return { response: cachedResponse(cached), status: "HIT", key };
  } catch {
    // A cache lookup failure must never fail the page.
  }

  const response = await fetchOrigin();
  if (!isEdgeCacheableResponse(response)) {
    return { response: markedResponse(response, "BYPASS"), status: "BYPASS", key };
  }

  const cacheable = storedResponse(response.clone());
  const put = cache.put(key, cacheable).catch(() => undefined);
  if (options.waitUntil) options.waitUntil(put);
  else await put;
  return { response: markedResponse(response, "MISS"), status: "MISS", key };
}

/** Deletes one exact normalized key; used for the publication-time base purge. */
export async function purgeEdgeCacheKey(cache: EdgeCacheStorage | null, url: string): Promise<boolean> {
  if (!cache) return false;
  try {
    return await cache.delete(edgeCacheKeyUrl(url));
  } catch {
    return false;
  }
}
