import { CheerioCrawler, PlaywrightCrawler, RequestQueue } from "crawlee";
import { addDiagnosticAttempt, createDiagnosticsCollector } from "@/lib/crawler/diagnostics";
import { extractLinks } from "@/lib/crawler/extract-links";
import { extractHtmlMetadata } from "@/lib/crawler/extract-metadata";
import { extractReadableText } from "@/lib/crawler/extract-readable-text";
import { discoverSitemapUrls } from "@/lib/crawler/sitemap";
import type {
  CollectionConfidence,
  CrawlAttemptLog,
  CrawlStrategy,
  CrawlStrategyOption,
  CrawlerDiagnosticsCollector,
} from "@/lib/crawler/types";
import type { DiscoveredItem, RawArticle } from "@/lib/sources/types";
import { canonicalizeUrl } from "@/lib/utils/canonical-url";
import type {
  CrawleeSpiderItem,
  CrawleeSpiderOptions,
  CrawleeSpiderResult,
  CrawleeStartRequest,
  OfficialSpiderConfig,
} from "@/lib/crawlee/types";

interface SpiderRunState {
  config: OfficialSpiderConfig;
  options: CrawleeSpiderOptions;
  diagnostics: CrawlerDiagnosticsCollector;
  itemsByKey: Map<string, CrawleeSpiderItem>;
  strategySequence: CrawlStrategy[];
  usedSeedFallback: boolean;
  limit: number;
}

function configureStorage() {
  process.env.CRAWLEE_STORAGE_DIR ??= ".crawlee-storage";
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function envBoolean(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function crawlerSettings() {
  const timeoutMs = envNumber("CRAWLER_TIMEOUT_MS", 30000);
  return {
    maxConcurrency: Math.max(1, envNumber("CRAWLEE_MAX_CONCURRENCY", 2)),
    playwrightMaxConcurrency: Math.max(1, envNumber("CRAWLEE_PLAYWRIGHT_MAX_CONCURRENCY", envNumber("PLAYWRIGHT_MAX_CONCURRENCY", 1))),
    maxRequestRetries: envNumber("CRAWLEE_MAX_RETRIES", envNumber("CRAWLER_RETRY_COUNT", 2)),
    sameDomainDelaySecs: envNumber("CRAWLEE_SAME_DOMAIN_DELAY_SECS", envNumber("CRAWLER_DELAY_MS", 2000) / 1000),
    requestHandlerTimeoutSecs: Math.max(5, envNumber("CRAWLEE_REQUEST_TIMEOUT_SECS", timeoutMs / 1000)),
    navigationTimeoutSecs: Math.max(5, envNumber("CRAWLEE_NAVIGATION_TIMEOUT_SECS", envNumber("PLAYWRIGHT_TIMEOUT_MS", 45000) / 1000)),
    userAgent: process.env.CRAWLER_USER_AGENT || process.env.INGEST_USER_AGENT || "worldcons/0.1 crawler",
  };
}

function headerValue(headers: Record<string, unknown> | undefined, name: string) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value.map(String).join(", ");
  return value === undefined ? undefined : String(value);
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : "Error";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isTimeout(error: unknown) {
  return /timeout|timed out|ETIMEDOUT/i.test(errorMessage(error));
}

function uniqueKey(url: string, label: string, strategy: CrawlStrategy) {
  return `${strategy}:${label}:${canonicalizeUrl(url)}`;
}

function strategyAllowed(requested: CrawlStrategyOption | undefined, stage: CrawlStrategy) {
  const strategy = requested ?? "auto";
  if (strategy === "auto") return true;
  if (stage === "cheerio" && (strategy === "fetch" || strategy === "rss")) return true;
  return strategy === stage;
}

function shouldUsePlaywrightCrawler(options: CrawleeSpiderOptions) {
  if (options.usePlaywright === false) return false;
  if (!envBoolean("CRAWLEE_PLAYWRIGHT_ENABLED", true)) return false;
  return options.usePlaywright === true || envBoolean("PLAYWRIGHT_ENABLED", true);
}

function boundedLimit(options: CrawleeSpiderOptions) {
  return Math.max(1, options.limit ?? envNumber("CRAWLEE_DISCOVER_LIMIT_PER_SOURCE", envNumber("INGEST_LIMIT_PER_SOURCE", 20)));
}

function defaultConfidence(strategy: CrawlStrategy, textLength: number, sourceUrlVerified: boolean): CollectionConfidence {
  if (strategy === "seed") return sourceUrlVerified && textLength >= 1000 ? "medium" : "low";
  if (strategy === "sitemap") return sourceUrlVerified && textLength >= 1000 ? "medium" : "low";
  if (!sourceUrlVerified) return "low";
  if (textLength < 500) return "low";
  return "high";
}

function diagnosticsForMetadata(item: DiscoveredItem, diagnostics: CrawlerDiagnosticsCollector) {
  return [...(item.metadata?.diagnostics ?? []), ...diagnostics.attempts].slice(-50);
}

function rawFromHtml(params: {
  item: DiscoveredItem;
  html: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  strategy: CrawlStrategy;
  transport: "crawlee-cheerio" | "crawlee-playwright";
  diagnostics: CrawlerDiagnosticsCollector;
  config: OfficialSpiderConfig;
}): RawArticle {
  const { item, html, finalUrl, status, contentType, strategy, transport, diagnostics, config } = params;
  const metadata = extractHtmlMetadata(html);
  const text = extractReadableText(html, finalUrl, config.bodySelectors);
  const sourceUrlVerified = status > 0 && status < 400;
  const confidence = (config.confidenceFor ?? defaultConfidence)(strategy, text.length, sourceUrlVerified);
  const sourceTextAvailable = text.trim().length >= 1000;
  const publishable = sourceUrlVerified && sourceTextAvailable && strategy !== "seed";

  return {
    ...item,
    url: finalUrl,
    canonicalUrl: canonicalizeUrl(finalUrl),
    title: metadata.title ?? item.title,
    publishedAt: metadata.publishedAt ?? item.publishedAt,
    html,
    text,
    metadata: {
      ...item.metadata,
      collection: {
        strategy,
        confidence,
        sourceUrlVerified,
        diagnosticsId: item.metadata?.collection?.diagnosticsId,
        publishable,
        sourceTextAvailable,
        reason: publishable ? undefined : "Official source text could not be verified at publishable length.",
      },
      crawledMetadata: {
        description: metadata.description,
        decisionNumber: metadata.decisionNumber,
        caseNumber: metadata.caseNumber,
        senateOrChamber: metadata.senateOrChamber,
      },
      diagnostics: diagnosticsForMetadata(item, diagnostics),
      contentTypeHeader: contentType,
      extraction: transport,
      crawlee: {
        transport,
        sourceUrlVerified,
      },
    },
  };
}

function rawFromMetadataOnly(item: DiscoveredItem, diagnostics: CrawlerDiagnosticsCollector): RawArticle {
  return {
    ...item,
    text: [item.title, item.publishedAt, item.url].filter(Boolean).join("\n"),
    metadata: {
      ...item.metadata,
      collection: {
        strategy: item.metadata?.collection?.strategy ?? "seed",
        confidence: "low",
        sourceUrlVerified: false,
        publishable: false,
        sourceTextAvailable: false,
        diagnosticsId: item.metadata?.collection?.diagnosticsId,
        reason: "Live discovery or source text fetch failed. Seed URL was stored for later retry.",
      },
      diagnostics: diagnosticsForMetadata(item, diagnostics),
      warning: item.metadata?.warning ?? "Crawlee seed fallback used metadata only because the official source text could not be fetched.",
    },
  };
}

function remember(state: SpiderRunState, item: DiscoveredItem, raw?: RawArticle) {
  const key = canonicalizeUrl(raw?.canonicalUrl ?? raw?.url ?? item.canonicalUrl ?? item.url);
  const existing = state.itemsByKey.get(key);
  const existingLength = existing?.raw?.text?.length ?? 0;
  const nextLength = raw?.text?.length ?? 0;
  if (!existing || nextLength >= existingLength) {
    state.itemsByKey.set(key, { item: raw ?? item, raw });
  }
}

function results(state: SpiderRunState) {
  const values = Array.from(state.itemsByKey.values());
  const sorted = state.config.sortItems ? state.config.sortItems(values) : values;
  return sorted.slice(0, state.limit);
}

function remainingCount(state: SpiderRunState) {
  return Math.max(0, state.limit - results(state).length);
}

function buildRequest(request: CrawleeStartRequest, settings: ReturnType<typeof crawlerSettings>) {
  return {
    url: request.url,
    uniqueKey: uniqueKey(request.url, request.label, request.collectionStrategy),
    headers: {
      "User-Agent": settings.userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "de,fr,en;q=0.8,ko;q=0.6",
    },
    userData: request,
  };
}

function listRequests(config: OfficialSpiderConfig, strategy: CrawlStrategy): CrawleeStartRequest[] {
  return config.listUrls.map((url) => ({
    url,
    label: "LIST",
    collectionStrategy: strategy,
  }));
}

function detailRequests(config: OfficialSpiderConfig, urls: string[], strategy: CrawlStrategy, fallback = false): CrawleeStartRequest[] {
  return urls
    .filter((url) => config.isCandidateUrl(url))
    .map((url) => ({
      url,
      label: "DETAIL",
      item: config.itemFromUrl(url, strategy, { collectionStrategy: strategy }),
      collectionStrategy: strategy,
      fallback,
    }));
}

function seedRequests(config: OfficialSpiderConfig): CrawleeStartRequest[] {
  return config.seedItems.map((seed) => {
    const item = config.itemFromUrl(seed.url, "seed", {
      title: seed.title,
      warning: "Collected from configured official URL seed after live Crawlee discovery/fetch failed.",
    });
    return {
      url: seed.url,
      label: "DETAIL",
      item: { ...item, publishedAt: seed.publishedAt ?? item.publishedAt },
      collectionStrategy: "seed",
      fallback: true,
    };
  });
}

function addAttempt(diagnostics: CrawlerDiagnosticsCollector, attempt: CrawlAttemptLog) {
  addDiagnosticAttempt(diagnostics, attempt);
}

async function enqueueStartRequests(queue: RequestQueue, requests: CrawleeStartRequest[], settings: ReturnType<typeof crawlerSettings>) {
  for (const request of requests) {
    await queue.addRequest(buildRequest(request, settings));
  }
}

async function runCheerioPass(state: SpiderRunState, requests: CrawleeStartRequest[], name: string) {
  if (requests.length === 0) return;
  configureStorage();
  state.strategySequence.push("cheerio");
  const settings = crawlerSettings();
  const requestQueue = await RequestQueue.open(`${state.config.sourceKey}-${name}-cheerio-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await enqueueStartRequests(requestQueue, requests, settings);

  const crawler = new CheerioCrawler({
    requestQueue,
    maxConcurrency: settings.maxConcurrency,
    maxRequestRetries: settings.maxRequestRetries,
    sameDomainDelaySecs: settings.sameDomainDelaySecs,
    requestHandlerTimeoutSecs: settings.requestHandlerTimeoutSecs,
    navigationTimeoutSecs: settings.requestHandlerTimeoutSecs,
    async requestHandler({ request, $, response }) {
      const userData = request.userData as CrawleeStartRequest;
      const finalUrl = request.loadedUrl ?? request.url;
      const html = $.html();
      const status = Number(response.statusCode ?? 0);
      const contentType = headerValue(response.headers as Record<string, unknown>, "content-type");

      if (userData.label === "LIST") {
        const parsed = extractLinks(html, finalUrl, state.config.listSelectors);
        const links = parsed.links
          .filter((link) => state.config.isCandidateUrl(link.url, link.title))
          .slice(0, Math.max(state.limit * 5, 20));
        addAttempt(state.diagnostics, {
          url: request.url,
          finalUrl,
          strategy: userData.collectionStrategy,
          status,
          contentType,
          selectorMatched: parsed.selectorMatched,
          selectorMatchCount: parsed.selectorMatchCount,
          discoveredCount: links.length,
          fallback: userData.fallback,
          htmlLength: html.length,
        });

        for (const link of links) {
          const item = state.config.itemFromUrl(link.url, userData.collectionStrategy, {
            listingUrl: request.url,
            title: link.title,
            surroundingText: link.surroundingText,
            collectionStrategy: userData.collectionStrategy,
          });
          await requestQueue.addRequest(
            buildRequest(
              {
                url: link.url,
                label: "DETAIL",
                item,
                collectionStrategy: userData.collectionStrategy,
                fallback: userData.fallback,
                listingUrl: request.url,
              },
              settings,
            ),
          );
        }
        return;
      }

      const item = userData.item ?? state.config.itemFromUrl(finalUrl, userData.collectionStrategy, { listingUrl: userData.listingUrl });
      const raw = rawFromHtml({
        item,
        html,
        finalUrl,
        status,
        contentType,
        strategy: userData.collectionStrategy,
        transport: "crawlee-cheerio",
        diagnostics: state.diagnostics,
        config: state.config,
      });
      addAttempt(state.diagnostics, {
        url: request.url,
        finalUrl,
        strategy: userData.collectionStrategy,
        status,
        contentType,
        selectorMatched: raw.text ? raw.text.length > 0 : false,
        selectorMatchCount: raw.text ? 1 : 0,
        fallback: userData.fallback,
        htmlLength: html.length,
      });
      remember(state, item, raw);
    },
    failedRequestHandler({ request }, error) {
      const userData = request.userData as CrawleeStartRequest;
      addAttempt(state.diagnostics, {
        url: request.url,
        strategy: userData.collectionStrategy,
        fallback: userData.fallback,
        timeout: isTimeout(error),
        errorCode: errorName(error),
        errorMessage: errorMessage(error),
      });
    },
  });

  await crawler.run().catch((error) => {
    addAttempt(state.diagnostics, {
      strategy: "cheerio",
      errorCode: errorName(error),
      errorMessage: errorMessage(error),
    });
  });
}

async function runPlaywrightPass(state: SpiderRunState, requests: CrawleeStartRequest[], name: string) {
  if (requests.length === 0) return;
  configureStorage();
  state.strategySequence.push("playwright");
  const settings = crawlerSettings();
  const requestQueue = await RequestQueue.open(`${state.config.sourceKey}-${name}-playwright-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await enqueueStartRequests(requestQueue, requests, settings);

  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: settings.playwrightMaxConcurrency,
    maxRequestRetries: settings.maxRequestRetries,
    sameDomainDelaySecs: settings.sameDomainDelaySecs,
    requestHandlerTimeoutSecs: settings.requestHandlerTimeoutSecs,
    navigationTimeoutSecs: settings.navigationTimeoutSecs,
    launchContext: {
      launchOptions: {
        headless: envBoolean("PLAYWRIGHT_HEADLESS", true),
      },
    },
    async requestHandler({ request, page, response }) {
      const userData = request.userData as CrawleeStartRequest;
      const finalUrl = page.url() || request.loadedUrl || request.url;
      const status = response?.status() ?? 0;
      const contentType = response?.headers()["content-type"];
      await page.waitForLoadState("domcontentloaded", { timeout: settings.navigationTimeoutSecs * 1000 }).catch(() => null);
      const html = await page.content();

      if (userData.label === "LIST") {
        const parsed = extractLinks(html, finalUrl, state.config.listSelectors);
        const links = parsed.links
          .filter((link) => state.config.isCandidateUrl(link.url, link.title))
          .slice(0, Math.max(state.limit * 5, 20));
        addAttempt(state.diagnostics, {
          url: request.url,
          finalUrl,
          strategy: "playwright",
          status,
          contentType,
          selectorMatched: parsed.selectorMatched,
          selectorMatchCount: parsed.selectorMatchCount,
          discoveredCount: links.length,
          fallback: true,
          htmlLength: html.length,
        });

        for (const link of links) {
          const item = state.config.itemFromUrl(link.url, "playwright", {
            listingUrl: request.url,
            title: link.title,
            surroundingText: link.surroundingText,
            collectionStrategy: "playwright",
          });
          await requestQueue.addRequest(
            buildRequest(
              {
                url: link.url,
                label: "DETAIL",
                item,
                collectionStrategy: "playwright",
                fallback: true,
                listingUrl: request.url,
              },
              settings,
            ),
          );
        }
        return;
      }

      const item = userData.item ?? state.config.itemFromUrl(finalUrl, userData.collectionStrategy, { listingUrl: userData.listingUrl });
      const raw = rawFromHtml({
        item,
        html,
        finalUrl,
        status,
        contentType,
        strategy: userData.collectionStrategy,
        transport: "crawlee-playwright",
        diagnostics: state.diagnostics,
        config: state.config,
      });
      addAttempt(state.diagnostics, {
        url: request.url,
        finalUrl,
        strategy: userData.collectionStrategy,
        status,
        contentType,
        selectorMatched: raw.text ? raw.text.length > 0 : false,
        selectorMatchCount: raw.text ? 1 : 0,
        fallback: true,
        htmlLength: html.length,
      });
      remember(state, item, raw);
    },
    failedRequestHandler({ request }, error) {
      addAttempt(state.diagnostics, {
        url: request.url,
        strategy: "playwright",
        fallback: true,
        timeout: isTimeout(error),
        errorCode: errorName(error),
        errorMessage: errorMessage(error),
      });
    },
  });

  await crawler.run().catch((error) => {
    addAttempt(state.diagnostics, {
      strategy: "playwright",
      fallback: true,
      timeout: isTimeout(error),
      errorCode: errorName(error),
      errorMessage: errorMessage(error),
    });
  });
}

async function runSitemapFallback(state: SpiderRunState) {
  state.strategySequence.push("sitemap");
  const discovered = (
    await Promise.all(
      state.config.sitemapBaseUrls.map((baseUrl) => discoverSitemapUrls(baseUrl, state.config.sitemapKeywords, state.diagnostics).catch(() => [])),
    )
  )
    .flat()
    .filter((url, index, array) => array.indexOf(url) === index)
    .filter((url) => state.config.isCandidateUrl(url))
    .slice(0, Math.max(state.limit * 5, 20));

  addAttempt(state.diagnostics, {
    strategy: "sitemap",
    discoveredCount: discovered.length,
    fallback: true,
  });

  const requests = detailRequests(state.config, discovered, "sitemap-detail", true);
  await runCheerioPass(state, requests, "sitemap-detail");

  if (shouldUsePlaywrightCrawler(state.options)) {
    const needsFallback = requests.filter((request) => {
      const existing = state.itemsByKey.get(canonicalizeUrl(request.url));
      return !existing?.raw?.text || existing.raw.text.trim().length < 1000;
    });
    if (needsFallback.length > 0) {
      await runPlaywrightPass(state, needsFallback.slice(0, Math.max(remainingCount(state), 1)), "sitemap-detail");
    }
  }
}

async function runSeedFallback(state: SpiderRunState) {
  state.usedSeedFallback = true;
  state.strategySequence.push("seed");
  const requests = seedRequests(state.config).slice(0, state.limit);
  await runCheerioPass(state, requests, "seed-detail");

  if (remainingCount(state) > 0 && shouldUsePlaywrightCrawler(state.options)) {
    const missing = requests.filter((request) => !state.itemsByKey.has(canonicalizeUrl(request.url)));
    await runPlaywrightPass(state, missing, "seed-detail");
  }

  for (const request of requests) {
    if (results(state).length >= state.limit) break;
    const key = canonicalizeUrl(request.url);
    if (state.itemsByKey.has(key)) continue;
    const item = request.item ?? state.config.itemFromUrl(request.url, "seed");
    remember(state, item, rawFromMetadataOnly(item, state.diagnostics));
  }

  addAttempt(state.diagnostics, {
    strategy: "seed",
    discoveredCount: requests.length,
    fallback: true,
    errorMessage: "Live Crawlee discovery did not produce enough verified articles; official URL seeds were used as final fallback.",
  });
}

export async function runOfficialSpider(config: OfficialSpiderConfig, options: CrawleeSpiderOptions = {}): Promise<CrawleeSpiderResult> {
  configureStorage();
  const diagnostics = options.diagnostics ?? createDiagnosticsCollector(config.sourceKey);
  const state: SpiderRunState = {
    config,
    options,
    diagnostics,
    itemsByKey: new Map(),
    strategySequence: [],
    usedSeedFallback: false,
    limit: boundedLimit(options),
  };
  const strategy = options.strategy ?? "auto";
  const directUrls = options.detailUrls?.filter((url) => config.isCandidateUrl(url)) ?? [];

  if (options.detailOnly || directUrls.length > 0) {
    if (strategyAllowed(strategy, "cheerio")) {
      await runCheerioPass(state, detailRequests(config, directUrls, strategy === "sitemap" || strategy === "seed" ? strategy : "cheerio"), "direct-detail");
    }
    if (remainingCount(state) > 0 && strategyAllowed(strategy, "playwright") && shouldUsePlaywrightCrawler(options)) {
      await runPlaywrightPass(state, detailRequests(config, directUrls, "playwright", true), "direct-detail");
    }
    return {
      sourceKey: config.sourceKey,
      items: results(state),
      diagnostics,
      strategySequence: state.strategySequence,
      usedSeedFallback: state.usedSeedFallback,
    };
  }

  let sitemapAlreadyTried = false;

  if (state.config.preferSitemap && remainingCount(state) > 0 && strategyAllowed(strategy, "sitemap") && strategy !== "seed") {
    await runSitemapFallback(state);
    sitemapAlreadyTried = true;
  }

  if (remainingCount(state) > 0 && strategyAllowed(strategy, "cheerio") && strategy !== "seed") {
    await runCheerioPass(state, listRequests(config, "cheerio"), "list");
  }

  if (remainingCount(state) > 0 && strategyAllowed(strategy, "playwright") && strategy !== "seed" && shouldUsePlaywrightCrawler(options)) {
    await runPlaywrightPass(state, listRequests(config, "playwright"), "list");
  } else if (remainingCount(state) > 0 && strategyAllowed(strategy, "playwright") && !shouldUsePlaywrightCrawler(options)) {
    addAttempt(diagnostics, {
      strategy: "playwright",
      fallback: true,
      errorCode: "PLAYWRIGHT_DISABLED",
      errorMessage: "PlaywrightCrawler fallback was requested but disabled by options or environment.",
    });
  }

  if (!sitemapAlreadyTried && remainingCount(state) > 0 && strategyAllowed(strategy, "sitemap") && strategy !== "seed") {
    await runSitemapFallback(state);
  }

  if (remainingCount(state) > 0 && strategyAllowed(strategy, "seed") && !state.config.disableSeedArticleFallback) {
    await runSeedFallback(state);
  }

  return {
    sourceKey: config.sourceKey,
    items: results(state),
    diagnostics,
    strategySequence: state.strategySequence,
    usedSeedFallback: state.usedSeedFallback,
  };
}
