import type { CrawlStrategy } from "@/lib/crawler/types";
import { SITEMAP_KEYWORDS } from "@/lib/crawler/sitemap";
import { titleFromUrl } from "@/lib/crawler/extract-metadata";
import { runOfficialSpider } from "@/lib/crawlee/shared";
import type { CrawleeSpiderItem, CrawleeSpiderOptions, OfficialSpiderConfig } from "@/lib/crawlee/types";
import type { DiscoveredItem } from "@/lib/sources/types";
import { canonicalizeUrl } from "@/lib/utils/canonical-url";
import { parseDate } from "@/lib/utils/dates";

export const CONSEIL_BASE_URL = "https://www.conseil-constitutionnel.fr";
export const QPC360_BASE_URL = "https://qpc360.conseil-constitutionnel.fr";

const LIST_URLS = [
  `${CONSEIL_BASE_URL}/les-decisions`,
  QPC360_BASE_URL,
];

const LIST_SELECTORS = [
  "a[href*='/decision/']",
  "a[href*='/decision-']",
];

const BODY_SELECTORS = [
  "main",
  "article",
  ".field--name-body",
  ".decision-content",
  ".content",
  "#content",
  "body",
];

export const QPC360_SEEDS = [
  {
    url: `${CONSEIL_BASE_URL}/decision/2026/20261198QPC.htm`,
    title: "Décision n° 2026-1198 QPC du 7 mai 2026",
    publishedAt: "7 mai 2026",
  },
  {
    url: `${CONSEIL_BASE_URL}/decision/2026/20261199QPC.htm`,
    title: "Décision n° 2026-1199 QPC du 7 mai 2026",
    publishedAt: "7 mai 2026",
  },
  {
    url: `${CONSEIL_BASE_URL}/decision/2026/2026320L.htm`,
    title: "Décision n° 2026-320 L du 30 avril 2026",
    publishedAt: "30 avril 2026",
  },
  {
    url: `${CONSEIL_BASE_URL}/decision/2026/2026168ORGA.htm`,
    title: "Décision n° 2026-168 ORGA du 30 avril 2026",
    publishedAt: "30 avril 2026",
  },
  {
    url: `${CONSEIL_BASE_URL}/decision/2026/20261195QPC.htm`,
    title: "Décision n° 2026-1195 QPC du 30 avril 2026",
    publishedAt: "30 avril 2026",
  },
];

function parseFrenchDatePriority(value?: string) {
  if (!value) return 0;
  const parsed = parseDate(value);
  if (parsed) return parsed.getTime();
  const normalized = value
    .toLowerCase()
    .replace("janvier", "january")
    .replace("février", "february")
    .replace("fevrier", "february")
    .replace("mars", "march")
    .replace("avril", "april")
    .replace("mai", "may")
    .replace("juin", "june")
    .replace("juillet", "july")
    .replace("août", "august")
    .replace("aout", "august")
    .replace("septembre", "september")
    .replace("octobre", "october")
    .replace("novembre", "november")
    .replace("décembre", "december")
    .replace("decembre", "december");
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isOfficialHost(url: string) {
  const hostname = new URL(url).hostname;
  return hostname === "www.conseil-constitutionnel.fr" || hostname === "qpc360.conseil-constitutionnel.fr";
}

function isQpcUrl(url: string, title = "") {
  return /qpc/i.test(`${url} ${title}`);
}

function isConseilDecisionPath(pathname: string) {
  return /^\/decision\/20\d{2}\/[^/]+\.(?:html?|htm)$/i.test(pathname);
}

function isQpc360DecisionPath(pathname: string) {
  return /^\/20\d{2}-\d{2}-\d{2}\/decision-/i.test(pathname);
}

function contentTypeForUrl(url: string) {
  const path = new URL(url).pathname;
  if (isConseilDecisionPath(path) || isQpc360DecisionPath(path)) return "decision" as const;
  return "other" as const;
}

function dateFromText(text: string) {
  return text.match(/\b\d{1,2}\s+[a-zéûôîïçàèù]+\s+\d{4}\b/i)?.[0] ?? text.match(/\b20\d{2}\b/)?.[0];
}

function decisionNumberFromText(text: string) {
  return text.match(/\b(?:Décision\s+)?n[°o]\s*[0-9]{4}-[0-9]+\s*(?:QPC|DC|AN|SEN)?\b/i)?.[0];
}

function isCandidateUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!isOfficialHost(parsed.toString())) return false;
  if (["/les-decisions", "/decision", "/decisions", "/recherche/jurisprudence/liste"].includes(parsed.pathname)) return false;
  if (/\.(jpg|jpeg|png|gif|webp|css|js|ico)$/i.test(parsed.pathname)) return false;
  return contentTypeForUrl(parsed.toString()) === "decision";
}

function itemFromUrl(url: string, strategy: CrawlStrategy, metadata: Record<string, unknown> = {}): DiscoveredItem {
  const title = typeof metadata.title === "string" && metadata.title ? metadata.title : titleFromUrl(url);
  const text = [url, title, metadata.surroundingText].filter(Boolean).join(" ");
  return {
    sourceKey: "fr-conseil-constitutionnel",
    url,
    canonicalUrl: canonicalizeUrl(url),
    title,
    publishedAt: dateFromText(text),
    contentType: "decision",
    metadata: {
      ...metadata,
      collection: {
        strategy,
        confidence: strategy === "seed" ? "low" : strategy === "sitemap" || strategy === "sitemap-detail" ? "medium" : "high",
        sourceUrlVerified: strategy !== "seed",
        publishable: false,
        sourceTextAvailable: false,
        reason:
          strategy === "seed"
            ? "Live discovery or source text fetch failed. Seed URL was stored for later retry."
            : "Official URL candidate discovered; source text has not been verified yet.",
      },
      bodySelectors: BODY_SELECTORS,
      collectionStrategy: strategy,
      decisionNumber: decisionNumberFromText(text),
      decisionDate: dateFromText(text),
      isQpc: isQpcUrl(url, title),
      originalLanguage: "fr",
    },
  };
}

function sortItems(items: CrawleeSpiderItem[]) {
  return [...items].sort(
    (a, b) => parseFrenchDatePriority(b.raw?.publishedAt ?? b.item.publishedAt) - parseFrenchDatePriority(a.raw?.publishedAt ?? a.item.publishedAt),
  );
}

const config: OfficialSpiderConfig = {
  sourceKey: "fr-conseil-constitutionnel",
  baseUrl: CONSEIL_BASE_URL,
  sitemapBaseUrls: [CONSEIL_BASE_URL, QPC360_BASE_URL],
  listUrls: LIST_URLS,
  listSelectors: LIST_SELECTORS,
  bodySelectors: BODY_SELECTORS,
  sitemapKeywords: SITEMAP_KEYWORDS["fr-conseil-constitutionnel"],
  seedItems: QPC360_SEEDS,
  disableSeedArticleFallback: true,
  itemFromUrl,
  isCandidateUrl,
  sortItems,
};

export function runFranceSpider(options: CrawleeSpiderOptions = {}) {
  process.env.FRANCE_CRAWL_DELAY_MS ??= "3000";
  process.env.FRANCE_TIMEOUT_MS ??= "90000";
  process.env.FRANCE_MAX_CONCURRENCY ??= "1";
  process.env.CRAWLER_DELAY_MS = process.env.FRANCE_CRAWL_DELAY_MS;
  process.env.CRAWLER_TIMEOUT_MS = process.env.FRANCE_TIMEOUT_MS;
  process.env.CRAWLEE_MAX_CONCURRENCY = process.env.FRANCE_MAX_CONCURRENCY;
  process.env.CRAWLEE_PLAYWRIGHT_MAX_CONCURRENCY = process.env.FRANCE_MAX_CONCURRENCY;
  process.env.CRAWLEE_REQUEST_TIMEOUT_SECS = String(Math.max(30, Math.ceil(Number(process.env.FRANCE_TIMEOUT_MS) / 1000)));
  process.env.CRAWLEE_NAVIGATION_TIMEOUT_SECS = String(Math.max(30, Math.ceil(Number(process.env.FRANCE_TIMEOUT_MS) / 1000)));
  return runOfficialSpider(config, options);
}
