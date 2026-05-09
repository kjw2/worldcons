import type { CrawlStrategy } from "@/lib/crawler/types";
import { SITEMAP_KEYWORDS } from "@/lib/crawler/sitemap";
import { titleFromUrl } from "@/lib/crawler/extract-metadata";
import { runOfficialSpider } from "@/lib/crawlee/shared";
import type { CrawleeSpiderItem, CrawleeSpiderOptions, OfficialSpiderConfig } from "@/lib/crawlee/types";
import type { DiscoveredItem } from "@/lib/sources/types";
import { canonicalizeUrl } from "@/lib/utils/canonical-url";

export const CONSEIL_BASE_URL = "https://www.conseil-constitutionnel.fr";
export const QPC360_BASE_URL = "https://qpc360.conseil-constitutionnel.fr";

const LIST_URLS = [
  `${CONSEIL_BASE_URL}/les-decisions`,
  `${CONSEIL_BASE_URL}/decision`,
  `${QPC360_BASE_URL}/recherche/jurisprudence/liste?items_per_page=20&sort_by=date&sort_order=DESC`,
  QPC360_BASE_URL,
];

const LIST_SELECTORS = [
  "a[href*='/decision/']",
  "a[href*='decision-']",
  "a[href*='qpc']",
  "a[href*='jurisprudence']",
  "main a[href]",
  "article a[href]",
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

const QPC360_SEEDS = [
  {
    url: `${QPC360_BASE_URL}/2026-04-17/decision-2026-1197-qpc-17-avril-2026`,
    title: "Décision n° 2026-1197 QPC du 17 avril 2026",
    publishedAt: "17 avril 2026",
  },
  {
    url: `${QPC360_BASE_URL}/2026-03-20/decision-2025-1187-qpc-20-mars-2026`,
    title: "Décision n° 2025-1187 QPC du 20 mars 2026",
    publishedAt: "20 mars 2026",
  },
  {
    url: `${QPC360_BASE_URL}/2026-03-19/decision-2025-1186-qpc-19-mars-2026`,
    title: "Décision n° 2025-1186 QPC du 19 mars 2026",
    publishedAt: "19 mars 2026",
  },
  {
    url: `${QPC360_BASE_URL}/2026-03-06/decision-2025-1183-qpc-6-mars-2026`,
    title: "Décision n° 2025-1183 QPC du 6 mars 2026",
    publishedAt: "6 mars 2026",
  },
  {
    url: `${QPC360_BASE_URL}/2026-02-20/decision-2025-1182-qpc-20-fevrier-2026`,
    title: "Décision n° 2025-1182 QPC du 20 février 2026",
    publishedAt: "20 février 2026",
  },
];

function parseFrenchDatePriority(value?: string) {
  if (!value) return 0;
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

function contentTypeForUrl(url: string) {
  const path = new URL(url).pathname.toLowerCase();
  if (path.includes("decision") || path.includes("jurisprudence") || isQpcUrl(url)) return "decision" as const;
  return "other" as const;
}

function dateFromText(text: string) {
  return text.match(/\b\d{1,2}\s+[a-zéûôîïçàèù]+\s+\d{4}\b/i)?.[0] ?? text.match(/\b20\d{2}\b/)?.[0];
}

function decisionNumberFromText(text: string) {
  return text.match(/\b(?:Décision\s+)?n[°o]\s*[0-9]{4}-[0-9]+\s*(?:QPC|DC|AN|SEN)?\b/i)?.[0];
}

function isCandidateUrl(url: string, title = "") {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!isOfficialHost(parsed.toString())) return false;
  if (["/les-decisions", "/decision", "/decisions", "/recherche/jurisprudence/liste"].includes(parsed.pathname)) return false;
  if (/\.(jpg|jpeg|png|gif|webp|css|js|ico)$/i.test(parsed.pathname)) return false;
  return contentTypeForUrl(parsed.toString()) === "decision" || isQpcUrl(parsed.toString(), title);
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
  itemFromUrl,
  isCandidateUrl,
  sortItems,
};

export function runFranceSpider(options: CrawleeSpiderOptions = {}) {
  return runOfficialSpider(config, options);
}
