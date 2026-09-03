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
