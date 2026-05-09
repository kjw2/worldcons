import { crawlerUserAgent } from "@/lib/crawler/user-agents";
import { respectRateLimit } from "@/lib/crawler/rate-limit";
import { delay } from "@/lib/crawler/retry";
import type { CrawlRequest, CrawlResponse } from "@/lib/crawler/types";

const DEFAULT_TIMEOUT_MS = 45_000;
let activePlaywrightRuns = 0;

export function isPlaywrightEnabled() {
  return process.env.PLAYWRIGHT_ENABLED !== "false";
}

async function enterPlaywrightSlot() {
  const max = Math.max(1, Number(process.env.PLAYWRIGHT_MAX_CONCURRENCY ?? 1));
  while (activePlaywrightRuns >= max) {
    await delay(250);
  }
  activePlaywrightRuns += 1;
}

function leavePlaywrightSlot() {
  activePlaywrightRuns = Math.max(0, activePlaywrightRuns - 1);
}

export async function crawlWithPlaywright(request: CrawlRequest): Promise<CrawlResponse> {
  if (!isPlaywrightEnabled() && !request.usePlaywright) {
    return {
      url: request.url,
      finalUrl: request.url,
      status: 0,
      headers: {},
      fetchedAt: new Date().toISOString(),
      strategy: "playwright",
      diagnostics: {
        errorCode: "PLAYWRIGHT_DISABLED",
        errorMessage: "Playwright fallback is disabled.",
      },
    };
  }

  await respectRateLimit(request.url);
  await enterPlaywrightSlot();

  let browser: Awaited<ReturnType<(typeof import("playwright"))["chromium"]["launch"]>> | null = null;
  try {
    const { chromium } = await import("playwright");
    const timeoutMs = request.timeoutMs ?? Number(process.env.PLAYWRIGHT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== "false" });
    const page = await browser.newPage({ userAgent: crawlerUserAgent() });
    const pageResponse = await page.goto(request.url, {
      waitUntil: request.waitUntil ?? "domcontentloaded",
      timeout: timeoutMs,
    });
    let selectorMatched = undefined;
    if (request.waitForSelector) {
      try {
        await page.waitForSelector(request.waitForSelector, { timeout: Math.min(timeoutMs, 10_000) });
        selectorMatched = true;
      } catch {
        selectorMatched = false;
      }
    }

    const html = await page.content();
    const title = await page.title().catch(() => "");
    const description = await page.locator("meta[name='description']").first().getAttribute("content").catch(() => null);
    const finalUrl = page.url();
    const status = pageResponse?.status() ?? 200;
    const contentType = pageResponse?.headers()["content-type"];
    await browser.close();

    return {
      url: request.url,
      finalUrl,
      status,
      contentType,
      html,
      text: html,
      headers: pageResponse?.headers() ?? {},
      fetchedAt: new Date().toISOString(),
      strategy: "playwright",
      diagnostics: {
        redirected: finalUrl !== request.url,
        redirectChain: finalUrl !== request.url ? [request.url, finalUrl] : undefined,
        blocked: status === 403 || status === 429,
        selectorMatched,
        title,
        description,
        errorCode: status >= 400 ? `HTTP_${status}` : undefined,
        errorMessage: status >= 400 ? "Playwright navigation returned an HTTP error." : undefined,
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    return {
      url: request.url,
      finalUrl: request.url,
      status: 0,
      headers: {},
      fetchedAt: new Date().toISOString(),
      strategy: "playwright",
      diagnostics: {
        timeout: /timeout/i.test(message),
        errorCode: /timeout/i.test(message) ? "TIMEOUT" : "PLAYWRIGHT_ERROR",
        errorMessage: message,
      },
    };
  } finally {
    leavePlaywrightSlot();
  }
}
