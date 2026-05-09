import type { CrawlStrategy } from "@/lib/crawler/types";
import { applyIpv4FirstForSource } from "@/lib/crawler/dns-policy";
import { SITEMAP_KEYWORDS } from "@/lib/crawler/sitemap";
import { titleFromUrl } from "@/lib/crawler/extract-metadata";
import { runOfficialSpider } from "@/lib/crawlee/shared";
import type { CrawleeSpiderItem, CrawleeSpiderOptions, OfficialSpiderConfig } from "@/lib/crawlee/types";
import type { DiscoveredItem } from "@/lib/sources/types";
import { canonicalizeUrl } from "@/lib/utils/canonical-url";

export const BVERFG_BASE_URL = "https://www.bundesverfassungsgericht.de";

const LIST_URLS = [
  `${BVERFG_BASE_URL}/DE/Entscheidungen/entscheidungen_node.html`,
  `${BVERFG_BASE_URL}/SiteGlobals/Forms/Suche/Entscheidungssuche/Entscheidungssuche_Formular.html?nn=68086&callerId=148438`,
  `${BVERFG_BASE_URL}/SiteGlobals/Forms/Suche/Entscheidungensuche_Formular.html`,
  `${BVERFG_BASE_URL}/DE/Entscheidungen/Entscheidungen_node.html`,
  BVERFG_BASE_URL,
];

const LIST_SELECTORS = [
  "a[href*='/SharedDocs/Entscheidungen/']",
  "a[href*='Entscheidungen/DE/']",
  "a[href*='entscheidung']",
  "a[href*='Decision']",
  "main a[href]",
  "article a[href]",
];

const BODY_SELECTORS = [
  "main",
  "article",
  "#pagemaindiv",
  ".c-detail",
  ".content",
  "#content",
  "body",
];

export const BVERFG_SEED_DECISIONS = [
  {
    url: `${BVERFG_BASE_URL}/SharedDocs/Entscheidungen/DE/2025/09/rk20250923_2bvr062525.html`,
    title: "Beschluss vom 23. September 2025 - 2 BvR 625/25",
    publishedAt: "23.09.2025",
  },
  {
    url: `${BVERFG_BASE_URL}/SharedDocs/Entscheidungen/DE/2025/08/rk20250812_2bvr053025.html`,
    title: "Beschluss vom 12. August 2025 - 2 BvR 530/25",
    publishedAt: "12.08.2025",
  },
  {
    url: `${BVERFG_BASE_URL}/SharedDocs/Entscheidungen/DE/2025/07/ls20250723_2bvl001914.html`,
    title: "Beschluss vom 23. Juli 2025 - 2 BvL 19/14",
    publishedAt: "23.07.2025",
  },
  {
    url: `${BVERFG_BASE_URL}/SharedDocs/Entscheidungen/DE/2025/07/rk20250721_1bvr039824.html`,
    title: "Beschluss vom 21. Juli 2025 - 1 BvR 398/24",
    publishedAt: "21.07.2025",
  },
  {
    url: `${BVERFG_BASE_URL}/SharedDocs/Entscheidungen/DE/2025/06/rs20250624_1bvr018023.html`,
    title: "Beschluss vom 24. Juni 2025 - 1 BvR 180/23",
    publishedAt: "24.06.2025",
  },
];

function parseDatePriority(value?: string) {
  if (!value) return 0;
  const germanDate = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (germanDate) {
    const [, day, month, year] = germanDate;
    return Date.UTC(Number(year), Number(month) - 1, Number(day));
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function contentTypeForUrl(url: string) {
  const path = new URL(url).pathname;
  if (/\/SharedDocs\/Entscheidungen\/(?:DE|EN)\//i.test(path) || /entscheidung|decision/i.test(path)) return "decision" as const;
  return "other" as const;
}

function dateFromText(text: string) {
  return text.match(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/)?.[0] ?? text.match(/\b20\d{2}\b/)?.[0];
}

function caseNumberFromText(text: string) {
  return text.match(/\b(?:1|2)\s+Bv[A-Za-z]+\s+\d+\/\d{2,4}\b/)?.[0];
}

function senateFromText(text: string) {
  return text.match(/\b(?:Erster|Zweiter)\s+Senat\b/i)?.[0] ?? text.match(/\b\d+\.\s+Kammer\b/i)?.[0];
}

function isOfficialHost(url: string) {
  const hostname = new URL(url).hostname;
  return hostname === "www.bundesverfassungsgericht.de" || hostname === "www.bverfg.de";
}

function isCandidateUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!isOfficialHost(parsed.toString())) return false;
  if (!parsed.pathname.endsWith(".html") && !parsed.pathname.endsWith(".pdf")) return false;
  return contentTypeForUrl(parsed.toString()) === "decision";
}

function itemFromUrl(url: string, strategy: CrawlStrategy, metadata: Record<string, unknown> = {}): DiscoveredItem {
  const title = typeof metadata.title === "string" && metadata.title ? metadata.title : titleFromUrl(url);
  const text = [url, title, metadata.surroundingText].filter(Boolean).join(" ");
  return {
    sourceKey: "de-bverfg",
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
      decisionDate: dateFromText(text),
      caseNumber: caseNumberFromText(text),
      senateOrChamber: senateFromText(text),
      originalLanguage: "de",
    },
  };
}

function sortItems(items: CrawleeSpiderItem[]) {
  return [...items].sort(
    (a, b) => parseDatePriority(b.raw?.publishedAt ?? b.item.publishedAt) - parseDatePriority(a.raw?.publishedAt ?? a.item.publishedAt),
  );
}

const config: OfficialSpiderConfig = {
  sourceKey: "de-bverfg",
  baseUrl: BVERFG_BASE_URL,
  sitemapBaseUrls: [BVERFG_BASE_URL],
  listUrls: LIST_URLS,
  listSelectors: LIST_SELECTORS,
  bodySelectors: BODY_SELECTORS,
  sitemapKeywords: SITEMAP_KEYWORDS["de-bverfg"],
  seedItems: BVERFG_SEED_DECISIONS,
  preferSitemap: true,
  disableSeedArticleFallback: true,
  itemFromUrl,
  isCandidateUrl,
  sortItems,
};

export function runBverfgSpider(options: CrawleeSpiderOptions = {}) {
  process.env.BVERFG_CRAWL_DELAY_MS ??= "3000";
  process.env.BVERFG_TIMEOUT_MS ??= "60000";
  process.env.BVERFG_MAX_CONCURRENCY ??= "1";
  process.env.BVERFG_RETRY_COUNT ??= "2";
  process.env.BVERFG_USE_IPV4_FIRST ??= "true";
  process.env.CRAWLER_DELAY_MS ??= process.env.BVERFG_CRAWL_DELAY_MS;
  process.env.CRAWLER_TIMEOUT_MS ??= process.env.BVERFG_TIMEOUT_MS;
  process.env.CRAWLEE_MAX_CONCURRENCY ??= process.env.BVERFG_MAX_CONCURRENCY;
  process.env.CRAWLEE_PLAYWRIGHT_MAX_CONCURRENCY ??= process.env.BVERFG_MAX_CONCURRENCY;
  process.env.CRAWLER_RETRY_COUNT ??= process.env.BVERFG_RETRY_COUNT;
  applyIpv4FirstForSource("de-bverfg");
  return runOfficialSpider(config, options);
}
