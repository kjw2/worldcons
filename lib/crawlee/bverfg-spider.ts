import type { CrawlStrategy } from "@/lib/crawler/types";
import { addDiagnosticAttempt } from "@/lib/crawler/diagnostics";
import { assertCrawlerExecution, checkpointCrawlerExecution } from "@/lib/crawler/cancellation";
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
const DEJURE_BVERFG_INDEX_URL = "https://dejure.org/dienste/rechtsprechung?gericht=BVerfG";

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

function envPositiveInteger(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function envBoolean(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
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

export function bverfgCaseNumberFromText(text: string) {
  const displayed = text.match(/\b(?:1|2)\s+Bv[A-Za-z]+\s+\d+\/\d{2,4}\b/)?.[0];
  if (displayed) return displayed;

  const compact = text.match(/[_./]([12])bv([a-z]+)(\d{4})(\d{2})(?:\.html)?\b/i);
  if (!compact) return undefined;

  const number = String(Number(compact[3]));
  const suffix = `${compact[2].slice(0, 1).toUpperCase()}${compact[2].slice(1).toLowerCase()}`;
  return `${compact[1]} Bv${suffix} ${number}/${compact[4]}`;
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

function bverfgPrefixesForProcedure(procedure: string) {
  const normalized = procedure.toLowerCase();
  if (normalized === "bvr") return ["rk", "rs"];
  if (normalized === "bvq") return ["qk", "qs"];
  if (normalized === "bvc") return ["cs"];
  if (normalized === "bvl") return ["ls"];
  if (normalized === "bve") return ["es"];
  if (normalized === "bvf") return ["fs"];
  if (normalized === "bvb") return ["bs"];
  return [];
}

export function bverfgOfficialUrlCandidatesFromDocket(date: string, docket: string) {
  const dateMatch = date.match(/^(\d{2})\.(\d{2})\.(20\d{2})$/);
  const docketMatch = docket.match(/^([12])\s+Bv([A-Za-z]+)\s+(\d+)\/(\d{2,4})/);
  if (!dateMatch || !docketMatch) return [];

  const [, day, month, year] = dateMatch;
  const [, senate, procedureSuffix, number, docketYear] = docketMatch;
  const procedure = `bv${procedureSuffix.toLowerCase()}`;
  const prefixes = bverfgPrefixesForProcedure(procedure);
  if (prefixes.length === 0) return [];

  const casePart = `${senate}${procedure}${number.padStart(4, "0")}${docketYear.length === 4 ? docketYear.slice(-2) : docketYear}`;
  return prefixes.map(
    (prefix) => `${BVERFG_BASE_URL}/SharedDocs/Entscheidungen/DE/${year}/${month}/${prefix}${year}${month}${day}_${casePart}.html`,
  );
}

export function bverfgOfficialUrlCandidatesFromUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return [value];
  }

  const match = parsed.pathname.match(
    /^(.*\/SharedDocs\/Entscheidungen\/(?:DE|EN)\/20\d{2}\/\d{2}\/)(rk|rs|qk|qs)(\d{8}_[a-z0-9]+\.html)$/i,
  );
  if (!match) return [canonicalizeUrl(value)];

  const [, directory, prefix, suffix] = match;
  const variants = prefix.toLowerCase().startsWith("r") ? ["rk", "rs"] : ["qk", "qs"];
  return variants.map((variant) => {
    const candidate = new URL(parsed.toString());
    candidate.pathname = `${directory}${variant}${suffix}`;
    candidate.search = "";
    candidate.hash = "";
    return canonicalizeUrl(candidate.toString());
  });
}

function germanDisplayDate(date?: string | null) {
  const parsed = parseDate(date);
  if (!parsed) return date ?? undefined;
  return `${String(parsed.getUTCDate()).padStart(2, "0")}.${String(parsed.getUTCMonth() + 1).padStart(2, "0")}.${parsed.getUTCFullYear()}`;
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

function bverfgPublishedAtForHtml(_metadata: unknown, item: DiscoveredItem, finalUrl: string) {
  return dateFromText(finalUrl) ?? item.publishedAt;
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
      caseNumber: bverfgCaseNumberFromText(text),
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

function sortDiscoveredItems(items: DiscoveredItem[]) {
  return [...items].sort((a, b) => parseDatePriority(b.publishedAt) - parseDatePriority(a.publishedAt));
}

async function discoverOpenLegalDataCandidates(options: CrawleeSpiderOptions = {}) {
  const rangeStart = rangeStartForDays(options.rangeDays);
  const limit = Math.max(1, options.limit ?? 20);
  const items: DiscoveredItem[] = [];
  let nextUrl: string | null | undefined = OPEN_LEGAL_DATA_BVERFG_API;
  let pages = 0;

  while (nextUrl && pages < 4 && items.length < limit) {
    await checkpointCrawlerExecution(options);
    pages += 1;
    const response = await fetch(nextUrl, {
      headers: {
        "User-Agent": process.env.CRAWLER_USER_AGENT || process.env.INGEST_USER_AGENT || "worldcons/0.1 crawler",
        Accept: "application/json,text/plain;q=0.8,*/*;q=0.5",
      },
      signal: options.signal,
    });
    await checkpointCrawlerExecution(options);
    if (!response.ok) throw new Error(`Open Legal Data fetch failed: ${response.status}`);
    const payload = (await response.json()) as OpenLegalDataCaseList;
    await checkpointCrawlerExecution(options);
    const records = payload.results ?? [];

    for (const record of records) {
      await checkpointCrawlerExecution(options);
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

function cleanDejureDocket(value: string) {
  return value
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchIndexText(
  url: string,
  accept = "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5",
  options: CrawleeSpiderOptions = {},
) {
  await checkpointCrawlerExecution(options);
  const response = await fetch(url, {
    headers: {
      "User-Agent": process.env.CRAWLER_USER_AGENT || process.env.INGEST_USER_AGENT || "worldcons/0.1 crawler",
      Accept: accept,
      "Accept-Language": "de,en;q=0.8,ko;q=0.6",
    },
    signal: options.signal,
  });
  await checkpointCrawlerExecution(options);
  if (!response.ok) throw new Error(`Index fetch failed: ${response.status}`);
  const text = await response.text();
  await checkpointCrawlerExecution(options);
  return text;
}

async function discoverDejureCandidates(options: CrawleeSpiderOptions = {}) {
  const rangeStart = rangeStartForDays(options.rangeDays);
  const limit = Math.max(1, options.limit ?? 20);
  const maxPages = envPositiveInteger("BVERFG_DEJURE_PAGES", 4);
  const items: DiscoveredItem[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const indexUrl = page === 1 ? DEJURE_BVERFG_INDEX_URL : `${DEJURE_BVERFG_INDEX_URL}&seite=${page}`;
    await checkpointCrawlerExecution(options);
    const html = await fetchIndexText(indexUrl, undefined, options);
    const matches = [...html.matchAll(/BVerfG,\s*(\d{2}\.\d{2}\.20\d{2})\s*-\s*([^<\r\n]+)/g)];
    let sawInRange = false;
    let oldestDate: Date | undefined;

    for (const match of matches) {
      await checkpointCrawlerExecution(options);
      const date = match[1];
      const docket = cleanDejureDocket(match[2]);
      const parsedDate = parseDate(date);
      if (parsedDate && (!oldestDate || parsedDate < oldestDate)) oldestDate = parsedDate;
      if (!isInRange(date, rangeStart)) continue;

      const officialUrlCandidates = bverfgOfficialUrlCandidatesFromDocket(date, docket);
      const url = officialUrlCandidates[0];
      if (!url) continue;
      sawInRange = true;
      items.push({
        sourceKey: "de-bverfg",
        url,
        canonicalUrl: canonicalDecisionUrl(url),
        title: `Beschluss vom ${germanDisplayDate(date)} - ${docket}`,
        publishedAt: date,
        contentType: "decision",
        metadata: {
          discoveryIndex: "dejure.org",
          discoveryIndexUrl: indexUrl,
          caseNumber: docket,
          officialUrlCandidates,
          officialUrlResolverVersion: 2,
          collection: {
            source: BVERFG_BASE_URL,
            strategy: "api",
            confidence: "medium",
            sourceUrlVerified: true,
            publishable: false,
            sourceTextAvailable: false,
            reason:
              "BVerfG /SiteGlobals/ search page is robots-disallowed, so dejure.org is used as the list index only to derive the official decision detail URL.",
          },
          detailDiscoveryStrategy: "dejure-index-to-official-detail",
          originalLanguage: "de",
        },
      });
    }

    if (rangeStart && !sawInRange && oldestDate && oldestDate < rangeStart) break;
  }

  return sortDiscoveredItems(items).slice(0, limit);
}

function uniqueDiscoveredItems(items: DiscoveredItem[], options?: CrawleeSpiderOptions) {
  const seen = new Set<string>();
  const unique: DiscoveredItem[] = [];
  for (const item of items) {
    assertCrawlerExecution(options);
    const key = canonicalizeUrl(item.canonicalUrl ?? item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

async function discoverIndexCandidates(options: CrawleeSpiderOptions = {}) {
  const limit = Math.max(1, options.limit ?? 20);
  const items: DiscoveredItem[] = [];

  await discoverDejureCandidates(options)
    .then((candidates) => {
      addDiagnosticAttempt(options.diagnostics, {
        url: DEJURE_BVERFG_INDEX_URL,
        strategy: "api",
        discoveredCount: candidates.length,
        errorMessage:
          candidates.length > 0
            ? "BVerfG listing discovered through dejure.org; official detail pages are fetched from bundesverfassungsgericht.de."
            : "No BVerfG decisions were found in the requested collection date range from dejure.org.",
      });
      items.push(...candidates);
    })
    .catch((error) => {
      if (options.signal?.aborted) throw options.signal.reason;
      addDiagnosticAttempt(options.diagnostics, {
        url: DEJURE_BVERFG_INDEX_URL,
        strategy: "api",
        errorCode: error instanceof Error ? error.name : "DEJURE_INDEX_ERROR",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });

  if (envBoolean("BVERFG_USE_OPEN_LEGAL_DATA", true)) {
    await discoverOpenLegalDataCandidates(options)
      .then((candidates) => {
        addDiagnosticAttempt(options.diagnostics, {
          url: OPEN_LEGAL_DATA_BVERFG_API,
          strategy: "api",
          discoveredCount: candidates.length,
          errorMessage:
            candidates.length > 0
              ? "Open Legal Data provided auxiliary BVerfG candidates; dejure.org remains the primary listing basis."
              : "Open Legal Data did not provide auxiliary BVerfG candidates in the requested collection date range.",
        });
        items.push(...candidates);
      })
      .catch((error) => {
        if (options.signal?.aborted) throw options.signal.reason;
        addDiagnosticAttempt(options.diagnostics, {
          url: OPEN_LEGAL_DATA_BVERFG_API,
          strategy: "api",
          errorCode: error instanceof Error ? error.name : "OPEN_LEGAL_DATA_ERROR",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
  }

  await checkpointCrawlerExecution(options);
  return sortDiscoveredItems(uniqueDiscoveredItems(items, options)).slice(0, limit);
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
  publishedAtForHtml: bverfgPublishedAtForHtml,
};

function emptyIndexResult(options: CrawleeSpiderOptions = {}) {
  return {
    sourceKey: config.sourceKey,
    items: [],
    diagnostics: options.diagnostics ?? { sourceKey: config.sourceKey, attempts: [] },
    strategySequence: ["api" as const],
    usedSeedFallback: false,
  };
}

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
    return discoverIndexCandidates(options)
      .then((candidates) => {
        if (candidates.length === 0) {
          return emptyIndexResult(options);
        }
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
          detailItems: candidates,
          detailOnly: true,
          strategy: "auto",
          limit: candidates.length,
        });
      })
      .catch((error) => {
        if (options.signal?.aborted) throw options.signal.reason;
        addDiagnosticAttempt(options.diagnostics, {
          url: DEJURE_BVERFG_INDEX_URL,
          strategy: "api",
          errorCode: error instanceof Error ? error.name : "BVERFG_INDEX_ERROR",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return emptyIndexResult(options);
      });
  }

  return runOfficialSpider(config, options);
}
