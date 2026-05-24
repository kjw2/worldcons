import type { CrawlStrategy } from "@/lib/crawler/types";
import { addDiagnosticAttempt } from "@/lib/crawler/diagnostics";
import { applyIpv4FirstForSource } from "@/lib/crawler/dns-policy";
import { SITEMAP_KEYWORDS } from "@/lib/crawler/sitemap";
import { titleFromUrl } from "@/lib/crawler/extract-metadata";
import { runOfficialSpider } from "@/lib/crawlee/shared";
import type { CrawleeSpiderItem, CrawleeSpiderOptions, OfficialSpiderConfig } from "@/lib/crawlee/types";
import type { DiscoveredItem } from "@/lib/sources/types";
import { canonicalizeUrl } from "@/lib/utils/canonical-url";
import { parseDate } from "@/lib/utils/dates";

export const BVERFG_BASE_URL = "https://www.bundesverfassungsgericht.de";
const OPEN_LEGAL_DATA_BVERFG_API = "https://de.openlegaldata.io/api/cases/?court=3&format=json&o=-date";

const LIST_URLS = [
  `${BVERFG_BASE_URL}/DE/Entscheidungen/entscheidungen_node.html`,
];

const LIST_SELECTORS = [
  "a[href*='/SharedDocs/Entscheidungen/']",
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
    url: `${BVERFG_BASE_URL}/SharedDocs/Entscheidungen/DE/2026/04/qk20260417_2bvq002626.html`,
    title: "Beschluss vom 17. April 2026 - 2 BvQ 26/26",
    publishedAt: "17.04.2026",
  },
  {
    url: `${BVERFG_BASE_URL}/SharedDocs/Entscheidungen/DE/2026/04/rk20260416_2bvr005225.html`,
    title: "Beschluss vom 16. April 2026 - 2 BvR 52/25",
    publishedAt: "16.04.2026",
  },
  {
    url: `${BVERFG_BASE_URL}/SharedDocs/Entscheidungen/DE/2026/04/cs20260413_2bvc001124.html`,
    title: "Beschluss vom 13. April 2026 - 2 BvC 11/24",
    publishedAt: "13.04.2026",
  },
  {
    url: `${BVERFG_BASE_URL}/SharedDocs/Entscheidungen/DE/2026/04/qk20260413_1bvq004125.html`,
    title: "Beschluss vom 13. April 2026 - 1 BvQ 41/25",
    publishedAt: "13.04.2026",
  },
  {
    url: `${BVERFG_BASE_URL}/SharedDocs/Entscheidungen/DE/2026/04/rs20260410_1bvr228423.html`,
    title: "Beschluss vom 10. April 2026 - 1 BvR 2284/23, 1 BvR 2285/23",
    publishedAt: "10.04.2026",
  },
];

interface OpenLegalDataCase {
  file_number?: string | null;
  date?: string | null;
  type?: string | null;
  ecli?: string | null;
}

interface OpenLegalDataCaseList {
  next?: string | null;
  results?: OpenLegalDataCase[];
}

function parseDatePriority(value?: string) {
  if (!value) return 0;
  const parsed = parseDate(value);
  if (parsed) return parsed.getTime();
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function contentTypeForUrl(url: string) {
  const path = new URL(url).pathname;
  if (isDecisionDocumentPath(path)) return "decision" as const;
  return "other" as const;
}

function dateFromText(text: string) {
  const dotted = text.match(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/)?.[0];
  if (dotted) return dotted;
  const filenameDate = text.match(/\b[a-z]{2}(20\d{2})(\d{2})(\d{2})_[a-z0-9]+/i);
  if (filenameDate) {
    const [, year, month, day] = filenameDate;
    return `${day}.${month}.${year}`;
  }
  const pathDate = text.match(/\/(20\d{2})\/(\d{2})\//);
  if (pathDate) {
    const [, year, month] = pathDate;
    return `01.${month}.${year}`;
  }
  return text.match(/\b20\d{2}\b/)?.[0];
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

function isDecisionDocumentPath(pathname: string) {
  return /\/SharedDocs\/Entscheidungen\/(?:DE|EN)\/20\d{2}\/\d{2}\/[a-z]{2}\d{8}_[a-z0-9]+\.html$/i.test(pathname);
}

function rangeStartForDays(days?: number) {
  if (!days) return undefined;
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
}

function isInRange(value: string | null | undefined, rangeStart?: Date) {
  if (!rangeStart) return true;
  const parsed = parseDate(value);
  return Boolean(parsed && parsed >= rangeStart);
}

function bverfgUrlFromEcli(ecli?: string | null) {
  const match = ecli?.match(/^ECLI:DE:BVerfG:(20\d{2}):([a-z]{2})(\d{4})(\d{2})(\d{2})\.([a-z0-9]+)$/i);
  if (!match) return undefined;

  const [, year, prefix, ecliYear, month, day, casePart] = match;
  if (year !== ecliYear) return undefined;
  return `${BVERFG_BASE_URL}/SharedDocs/Entscheidungen/DE/${year}/${month}/${prefix.toLowerCase()}${year}${month}${day}_${casePart.toLowerCase()}.html`;
}

function isCandidateUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!isOfficialHost(parsed.toString())) return false;
  if (!parsed.pathname.endsWith(".html")) return false;
  return contentTypeForUrl(parsed.toString()) === "decision";
}

function canonicalDecisionUrl(url: string) {
  const parsed = new URL(url);
  if (isDecisionDocumentPath(parsed.pathname)) {
    parsed.search = "";
  }
  return canonicalizeUrl(parsed.toString());
}

function itemFromUrl(url: string, strategy: CrawlStrategy, metadata: Record<string, unknown> = {}): DiscoveredItem {
  const cleanUrl = canonicalDecisionUrl(url);
  const title = typeof metadata.title === "string" && metadata.title ? metadata.title : titleFromUrl(url);
  const text = [url, title, metadata.surroundingText].filter(Boolean).join(" ");
  return {
    sourceKey: "de-bverfg",
    url: cleanUrl,
    canonicalUrl: cleanUrl,
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

async function discoverOpenLegalDataCandidates(options: CrawleeSpiderOptions = {}) {
  const rangeStart = rangeStartForDays(options.rangeDays);
  const limit = Math.max(1, options.limit ?? 20);
  const items: DiscoveredItem[] = [];
  let nextUrl: string | null | undefined = OPEN_LEGAL_DATA_BVERFG_API;
  let pages = 0;

  while (nextUrl && pages < 4 && items.length < limit) {
    pages += 1;
    const response = await fetch(nextUrl, {
      headers: {
        "User-Agent": process.env.CRAWLER_USER_AGENT || process.env.INGEST_USER_AGENT || "worldcons/0.1 crawler",
        Accept: "application/json,text/plain;q=0.8,*/*;q=0.5",
      },
    });
    if (!response.ok) throw new Error(`Open Legal Data fetch failed: ${response.status}`);
    const payload = (await response.json()) as OpenLegalDataCaseList;
    const records = payload.results ?? [];

    for (const record of records) {
      if (!isInRange(record.date, rangeStart)) continue;
      const url = bverfgUrlFromEcli(record.ecli);
      if (!url) continue;
      items.push({
        sourceKey: "de-bverfg",
        url,
        canonicalUrl: canonicalDecisionUrl(url),
        title: [record.type, record.date, record.file_number].filter(Boolean).join(" - "),
        publishedAt: record.date ?? undefined,
        contentType: "decision",
        metadata: {
          discoveryIndex: "Open Legal Data",
          discoveryIndexUrl: nextUrl,
          ecli: record.ecli,
          caseNumber: record.file_number,
          collection: {
            source: BVERFG_BASE_URL,
            strategy: "api",
            confidence: "medium",
            sourceUrlVerified: true,
            publishable: false,
            sourceTextAvailable: false,
            reason: "BVerfG decision URL was derived from an external ECLI index; official source text is fetched from BVerfG.",
          },
          detailDiscoveryStrategy: "external-ecli-index-to-official-detail",
          originalLanguage: "de",
        },
      });
      if (items.length >= limit) break;
    }

    const oldest = records
      .map((record) => parseDate(record.date))
      .filter((date): date is Date => Boolean(date))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (rangeStart && oldest && oldest < rangeStart) break;
    nextUrl = payload.next;
  }

  return items;
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
  preferSitemap: false,
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

  if (!options.detailOnly && (!options.strategy || options.strategy === "auto" || options.strategy === "api")) {
    return discoverOpenLegalDataCandidates(options)
      .then((candidates) => {
        if (candidates.length === 0) {
          addDiagnosticAttempt(options.diagnostics, {
            url: OPEN_LEGAL_DATA_BVERFG_API,
            strategy: "api",
            discoveredCount: 0,
            errorMessage: "No BVerfG decisions were found in the requested collection date range.",
          });
          if (options.rangeDays) {
            return {
              sourceKey: config.sourceKey,
              items: [],
              diagnostics: options.diagnostics ?? { sourceKey: config.sourceKey, attempts: [] },
              strategySequence: ["api" as const],
              usedSeedFallback: false,
            };
          }
          return runOfficialSpider(config, options);
        }
        addDiagnosticAttempt(options.diagnostics, {
          url: OPEN_LEGAL_DATA_BVERFG_API,
          strategy: "api",
          discoveredCount: candidates.length,
          errorMessage: "BVerfG listing discovered through external ECLI index; official detail pages are fetched from bundesverfassungsgericht.de.",
        });
        if (options.dryRun) {
          return {
            sourceKey: config.sourceKey,
            items: candidates.map((item) => ({ item })),
            diagnostics: options.diagnostics ?? { sourceKey: config.sourceKey, attempts: [] },
            strategySequence: ["api" as const],
            usedSeedFallback: false,
          };
        }
        return runOfficialSpider(config, {
          ...options,
          detailUrls: candidates.map((candidate) => candidate.url),
          detailOnly: true,
          strategy: "auto",
          limit: candidates.length,
        });
      })
      .catch((error) => {
        addDiagnosticAttempt(options.diagnostics, {
          url: OPEN_LEGAL_DATA_BVERFG_API,
          strategy: "api",
          errorCode: error instanceof Error ? error.name : "OPEN_LEGAL_DATA_ERROR",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return runOfficialSpider(config, options);
      });
  }

  return runOfficialSpider(config, options);
}
