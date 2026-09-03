import type { CrawlerExecutionHooks } from "@/lib/crawler/types";

export async function withCrawlerRequestPermit<T>(
  url: string,
  hooks: CrawlerExecutionHooks | undefined,
  operation: () => Promise<T>,
) {
  const permit = await hooks?.requestGovernor?.acquire(url);
  try {
    return await operation();
  } finally {
    await permit?.release();
  }
}

function bufferedResponse(response: Response, body: ArrayBuffer) {
  const copy = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(copy, {
    url: { configurable: true, value: response.url },
    redirected: { configurable: true, value: response.redirected },
    type: { configurable: true, value: response.type },
  });
  return copy;
}

export async function governedBufferedFetch(
  url: string,
  init: RequestInit,
  hooks?: CrawlerExecutionHooks,
) {
  if (!hooks?.requestGovernor) return fetch(url, init);
  return withCrawlerRequestPermit(url, hooks, async () => {
    const response = await fetch(url, { ...init, redirect: "error" });
    const body = await response.arrayBuffer();
    return bufferedResponse(response, body);
  });
}
