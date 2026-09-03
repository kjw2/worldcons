import type {
  CrawlerExecutionHooks,
  CrawlerRequestGovernor,
  CrawlerRequestPermit,
} from "@/lib/crawler/types";

interface GovernedNavigationOptions {
  followRedirect?: unknown;
  maxRedirects?: number;
}

export function createCrawlerNavigationPermitController(
  governor?: CrawlerRequestGovernor,
) {
  const activePermits = new Map<object, CrawlerRequestPermit>();

  async function release(key: object) {
    const permit = activePermits.get(key);
    if (!permit) return;
    await permit.release();
    activePermits.delete(key);
  }

  return {
    enabled: Boolean(governor),
    async beforeNavigation(
      key: object,
      url: string,
      navigationOptions?: GovernedNavigationOptions,
    ) {
      await release(key);
      if (!governor) return;
      const permit = await governor.acquire(url);
      activePermits.set(key, permit);
      if (navigationOptions) {
        navigationOptions.followRedirect = false;
        navigationOptions.maxRedirects = 0;
      }
    },
    async afterNavigation(key: object, status: number) {
      await release(key);
      if (governor && status >= 300 && status < 400) {
        throw new Error("crawler.request_governor_redirect_blocked");
      }
    },
    release,
    async releaseAll() {
      const keys = [...activePermits.keys()];
      let firstError: unknown;
      for (const key of keys) {
        try {
          await release(key);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    },
  };
}

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

async function boundedResponseBody(response: Response, maxResponseBytes: number) {
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new Error("crawler.response_limit_invalid");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    await response.body?.cancel();
    throw new Error("crawler.response_too_large");
  }
  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maxResponseBytes) {
        await reader.cancel();
        throw new Error("crawler.response_too_large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

export async function governedBoundedFetch(
  url: string,
  init: RequestInit,
  maxResponseBytes: number,
  hooks?: CrawlerExecutionHooks,
) {
  return withCrawlerRequestPermit(url, hooks, async () => {
    const response = await fetch(url, {
      ...init,
      redirect: hooks?.requestGovernor ? "error" : init.redirect,
    });
    const body = await boundedResponseBody(response, maxResponseBytes);
    return bufferedResponse(response, body);
  });
}
