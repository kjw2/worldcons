import "dotenv/config";
import { load } from "cheerio";
import { createDiagnosticsCollector } from "@/lib/crawler/diagnostics";
import { checkRobotsAllowed, robotsDelayMs } from "@/lib/crawler/robots";
import { articleExists, articleExistsByNormalizedContent, insertNormalizedArticle } from "@/lib/ingest/run";
import { BVERFG_SEED_DECISIONS } from "@/lib/crawlee/bverfg-spider";
import { getSourceAdapter } from "@/lib/sources";
import type { DiscoveredItem, SourceAdapter } from "@/lib/sources/types";
import { canonicalizeUrl } from "@/lib/utils/canonical-url";
import { parseDate } from "@/lib/utils/dates";

const USER_AGENT = process.env.CRAWLER_USER_AGENT || process.env.INGEST_USER_AGENT || "worldcons/0.1 crawler";
const FROM = argValue("from") ?? "2026-01-01";
const TO = argValue("to") ?? "2026-05-09";
const DELAY_MS = Number(argValue("delay-ms") ?? process.env.RANGE_COLLECT_DELAY_MS ?? 5000);
const LIST_DELAY_MS = Number(argValue("list-delay-ms") ?? process.env.RANGE_COLLECT_LIST_DELAY_MS ?? 2500);
const USE_BVERFG_EXTERNAL_INDEX = argFlag("bverfg-use-external-index");
const USE_BVERFG_DEJURE_INDEX = argFlag("bverfg-use-dejure-index");
const BVERFG_DEJURE_PAGES = Number(argValue("bverfg-dejure-pages") ?? process.env.BVERFG_DEJURE_PAGES ?? 2);
const MAX_CANDIDATES_PER_SOURCE = Number(argValue("max-candidates") ?? process.env.RANGE_COLLECT_MAX_CANDIDATES ?? 0);
const SOURCES = new Set(
  (argValue("sources") ?? "us-scotus,de-bverfg,fr-conseil-constitutionnel")
    .split(",")
    .map((source) => source.trim())
    .filter(Boolean),
);

const SCOTUS_BASE_URL = "https://www.supremecourt.gov";
const BVERFG_BASE_URL = "https://www.bundesverfassungsgericht.de";
const CONSEIL_BASE_URL = "https://www.conseil-constitutionnel.fr";
const OPEN_LEGAL_DATA_BVERFG_API = "https://de.openlegaldata.io/api/cases/?court=3&format=json&o=-date";
const DEJURE_BVERFG_INDEX_URL = "https://dejure.org/dienste/rechtsprechung?gericht=BVerfg";

interface Candidate extends DiscoveredItem {
  country: "United States" | "Germany" | "France";
}

interface SourceReport {
  sourceKey: string;
  country: string;
  discoveredCount: number;
  attemptedCount: number;
  insertedCount: number;
  skippedExistingCount: number;
  skippedDuplicateCount: number;
  skippedOutOfRangeCount: number;
  skippedUnverifiedCount: number;
  skippedRobotsCount: number;
  failedCount: number;
  rawBytes: number;
  cleanedBytes: number;
  errors: string[];
  notes: string[];
}

function argValue(name: string) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function argValues(name: string) {
  return process.argv.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.slice(name.length + 3));
}

function argFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configureRespectfulDefaults() {
  process.env.CRAWLEE_MAX_CONCURRENCY = "1";
  process.env.CRAWLEE_PLAYWRIGHT_MAX_CONCURRENCY = "1";
  process.env.CRAWLEE_PLAYWRIGHT_ENABLED = "false";
  process.env.PLAYWRIGHT_ENABLED = "false";
  process.env.CRAWLER_DELAY_MS = String(DELAY_MS);
  process.env.BVERFG_CRAWL_DELAY_MS = String(DELAY_MS);
  process.env.BVERFG_MAX_CONCURRENCY = "1";
  process.env.BVERFG_TIMEOUT_MS ??= "60000";
  process.env.BVERFG_RETRY_COUNT ??= "2";
}

function rangeBounds() {
  const fromDate = parseRangeDate(FROM);
  const toDate = parseRangeDate(TO);
  if (!fromDate || !toDate) throw new Error(`Invalid date range: ${FROM}..${TO}`);
  return {
    from: new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate())),
    toExclusive: new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate() + 1)),
  };
}

function parseRangeDate(value: string) {
  const dateOnly = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnly) {
    return new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])));
  }
  return parseDate(value);
}

function yearsInRange() {
  const { from, toExclusive } = rangeBounds();
  const toInclusive = new Date(toExclusive.getTime() - 1);
  const years: number[] = [];
  for (let year = from.getUTCFullYear(); year <= toInclusive.getUTCFullYear(); year += 1) {
    years.push(year);
  }
  return years;
}

function inRange(value?: string | null) {
  const parsed = parseDate(value);
  if (!parsed) return false;
  const { from, toExclusive } = rangeBounds();
  return parsed >= from && parsed < toExclusive;
}

function embeddedLongDate(value?: string | null) {
  return value?.match(/\b\d{1,2}\s+[a-zäöüéûôîïçàèù]+\s+20\d{2}\b/i)?.[0];
}

function bestPublishedAt(raw: { publishedAt?: string; title?: string }, candidate: Candidate) {
  const candidates = [
    raw.publishedAt,
    embeddedLongDate(raw.publishedAt),
    embeddedLongDate(raw.title),
    candidate.publishedAt,
  ];
  return candidates.find((value) => Boolean(parseDate(value))) ?? raw.publishedAt ?? candidate.publishedAt;
}

function sourceReport(sourceKey: string, country: string): SourceReport {
  return {
    sourceKey,
    country,
    discoveredCount: 0,
    attemptedCount: 0,
    insertedCount: 0,
    skippedExistingCount: 0,
    skippedDuplicateCount: 0,
    skippedOutOfRangeCount: 0,
    skippedUnverifiedCount: 0,
    skippedRobotsCount: 0,
    failedCount: 0,
    rawBytes: 0,
    cleanedBytes: 0,
    errors: [],
    notes: [],
  };
}

async function respectfulFetchText(url: string, acceptLanguage: string) {
  return respectfulFetch(url, acceptLanguage, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
}

async function respectfulFetch(url: string, acceptLanguage: string, accept: string) {
  const robots = await checkRobotsAllowed(url);
  if (!robots.allowed) {
    throw new Error(`robots.txt disallows ${url}: ${robots.matchedRule ?? "(empty)"}`);
  }
  await sleep(Math.max(LIST_DELAY_MS, robotsDelayMs(robots)));
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: accept,
      "Accept-Language": acceptLanguage,
    },
  });
  if (!response.ok) throw new Error(`Fetch failed ${response.status} for ${url}`);
  return response.text();
}

function uniqueCandidates(items: Candidate[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.canonicalUrl;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function discoverScotusOpinions() {
  const items: Candidate[] = [];
  const terms = scotusTermsForRange();

  for (const term of terms) {
    const url = `${SCOTUS_BASE_URL}/opinions/slipopinion/${term}`;
    const html = await respectfulFetchText(url, "en;q=0.9");
    const $ = load(html);

    $("table.table tr").each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length < 4) return;

      const publishedAt = $(cells[1]).text().trim();
      if (!inRange(publishedAt)) return;

      const docket = $(cells[2]).text().trim();
      const link = $(cells[3]).find("a[href$='.pdf']").first();
      const href = link.attr("href");
      if (!href) return;

      const itemUrl = new URL(href, SCOTUS_BASE_URL).toString();
      items.push({
        country: "United States",
        sourceKey: "us-scotus",
        url: itemUrl,
        canonicalUrl: canonicalizeUrl(itemUrl),
        title: link.text().replace(/\s+/g, " ").trim(),
        publishedAt,
        contentType: "opinion",
        metadata: {
          docket,
          syllabus: link.attr("title"),
          listingUrl: url,
          officialListingCollected: true,
          officialPdfUrlDiscovered: true,
          collection: {
            source: SCOTUS_BASE_URL,
            strategy: "official-listing",
            confidence: "medium",
            sourceUrlVerified: true,
            sourceTextAvailable: false,
            publishable: false,
            reason: "Official SCOTUS slip opinion listing metadata collected; PDF source text must pass robots.txt before automatic summarization.",
          },
        },
      });
    });
  }

  return uniqueCandidates(items);
}

function scotusTermsForRange() {
  const { from, toExclusive } = rangeBounds();
  const terms = new Set<string>();
  for (let cursor = new Date(from); cursor < toExclusive; cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))) {
    const termStartYear = cursor.getUTCMonth() >= 9 ? cursor.getUTCFullYear() : cursor.getUTCFullYear() - 1;
    terms.add(String(termStartYear).slice(-2));
  }
  return [...terms].sort();
}

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

function bverfgUrlFromEcli(ecli?: string | null) {
  const match = ecli?.match(/^ECLI:DE:BVerfG:(20\d{2}):([a-z]{2})(\d{4})(\d{2})(\d{2})\.([a-z0-9]+)$/i);
  if (!match) return undefined;

  const [, year, prefix, ecliYear, month, day, casePart] = match;
  if (year !== ecliYear) return undefined;
  return `${BVERFG_BASE_URL}/SharedDocs/Entscheidungen/DE/${year}/${month}/${prefix.toLowerCase()}${year}${month}${day}_${casePart.toLowerCase()}.html`;
}

function bverfgPrefixForProcedure(procedure: string) {
  const normalized = procedure.toLowerCase();
  if (normalized === "bvr") return "rk";
  if (normalized === "bvq") return "qk";
  if (normalized === "bvc") return "cs";
  if (normalized === "bvl") return "ls";
  if (normalized === "bve") return "es";
  if (normalized === "bvf") return "fs";
  if (normalized === "bvb") return "bs";
  return undefined;
}

function bverfgUrlFromDocket(date: string, docket: string) {
  const dateMatch = date.match(/^(\d{2})\.(\d{2})\.(20\d{2})$/);
  const docketMatch = docket.match(/^([12])\s+Bv([A-Za-z]+)\s+(\d+)\/(\d{2,4})/);
  if (!dateMatch || !docketMatch) return undefined;

  const [, day, month, year] = dateMatch;
  const [, senate, procedureSuffix, number, docketYear] = docketMatch;
  const procedure = `bv${procedureSuffix.toLowerCase()}`;
  const prefix = bverfgPrefixForProcedure(procedure);
  if (!prefix) return undefined;

  const casePart = `${senate}${procedure}${number.padStart(4, "0")}${docketYear.length === 4 ? docketYear.slice(-2) : docketYear}`;
  return `${BVERFG_BASE_URL}/SharedDocs/Entscheidungen/DE/${year}/${month}/${prefix}${year}${month}${day}_${casePart}.html`;
}

function bverfgDateFromUrl(url: string) {
  const match = url.match(/\/SharedDocs\/Entscheidungen\/DE\/(20\d{2})\/(\d{2})\/[a-z]{2}(20\d{2})(\d{2})(\d{2})_/i);
  if (!match) return undefined;
  const [, pathYear, , fileYear, month, day] = match;
  if (pathYear !== fileYear) return undefined;
  return `${day}.${month}.${pathYear}`;
}

function germanDisplayDate(date?: string | null) {
  const parsed = parseDate(date);
  if (!parsed) return date ?? undefined;
  return `${String(parsed.getUTCDate()).padStart(2, "0")}.${String(parsed.getUTCMonth() + 1).padStart(2, "0")}.${parsed.getUTCFullYear()}`;
}

function bverfgDirectUrlCandidate(params: { url: string; title?: string; publishedAt?: string; discovery: string }): Candidate | undefined {
  const publishedAt = params.publishedAt ?? bverfgDateFromUrl(params.url);
  if (!inRange(publishedAt)) return undefined;
  return {
    country: "Germany" as const,
    sourceKey: "de-bverfg",
    url: params.url,
    canonicalUrl: canonicalizeUrl(params.url),
    title: params.title,
    publishedAt,
    contentType: "decision" as const,
    metadata: {
      collection: {
        source: BVERFG_BASE_URL,
        strategy: "cheerio",
        confidence: "medium",
        sourceUrlVerified: true,
        publishable: false,
        sourceTextAvailable: false,
        reason: "Official BVerfG decision detail URL collected directly without fetching the disallowed /SiteGlobals/ search page.",
      },
      detailDiscoveryStrategy: params.discovery,
    },
  };
}

function configuredBverfgDetailUrls() {
  return [
    ...argValues("bverfg-detail-url"),
    ...(process.env.BVERFG_DETAIL_URLS ?? "")
      .split(/[\s,]+/)
      .map((url) => url.trim())
      .filter(Boolean),
  ];
}

function bverfgSeedCandidates(): Candidate[] {
  return BVERFG_SEED_DECISIONS.map((seed) =>
    bverfgDirectUrlCandidate({
      url: seed.url,
      title: seed.title,
      publishedAt: seed.publishedAt,
      discovery: "configured-official-detail-url",
    }),
  ).filter((item): item is Candidate => Boolean(item));
}

function bverfgConfiguredDetailCandidates(): Candidate[] {
  return configuredBverfgDetailUrls()
    .map((url) =>
      bverfgDirectUrlCandidate({
        url,
        discovery: "user-supplied-official-detail-url",
      }),
    )
    .filter((item): item is Candidate => Boolean(item));
}

async function discoverBverfgFromOpenLegalData() {
  const items: Candidate[] = [];
  let nextUrl: string | null | undefined = OPEN_LEGAL_DATA_BVERFG_API;
  let pageCount = 0;

  while (nextUrl && pageCount < 10) {
    pageCount += 1;
    const json = await respectfulFetch(nextUrl, "de,en;q=0.8", "application/json,text/plain;q=0.8,*/*;q=0.5");
    const payload = JSON.parse(json) as OpenLegalDataCaseList;
    const results = payload.results ?? [];

    for (const record of results) {
      if (!inRange(record.date)) continue;
      const itemUrl = bverfgUrlFromEcli(record.ecli);
      if (!itemUrl) continue;
      const displayDate = germanDisplayDate(record.date);
      items.push({
        country: "Germany",
        sourceKey: "de-bverfg",
        url: itemUrl,
        canonicalUrl: canonicalizeUrl(itemUrl),
        title: [record.type, displayDate ? `vom ${displayDate}` : undefined, record.file_number ? `- ${record.file_number}` : undefined]
          .filter(Boolean)
          .join(" "),
        publishedAt: record.date ?? undefined,
        contentType: "decision",
        metadata: {
          discoveryIndex: "Open Legal Data",
          discoveryIndexUrl: nextUrl,
          ecli: record.ecli,
          caseNumber: record.file_number,
          collection: {
            source: BVERFG_BASE_URL,
            strategy: "cheerio",
            confidence: "medium",
            sourceUrlVerified: true,
            publishable: false,
            sourceTextAvailable: false,
            reason:
              "BVerfG /SiteGlobals/ search page is robots-disallowed, so an external ECLI index was used only to derive the official decision detail URL.",
          },
          detailDiscoveryStrategy: "external-index-to-official-detail",
        },
      });
    }

    const oldest = results
      .map((record) => parseDate(record.date))
      .filter((date): date is Date => Boolean(date))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const { from } = rangeBounds();
    if (oldest && oldest < from) break;
    nextUrl = payload.next;
  }

  return items;
}

async function discoverBverfgFromDejureIndex() {
  const items: Candidate[] = [];
  const { from } = rangeBounds();

  for (let page = 1; page <= Math.max(1, BVERFG_DEJURE_PAGES); page += 1) {
    const indexUrl = page === 1 ? DEJURE_BVERFG_INDEX_URL : `${DEJURE_BVERFG_INDEX_URL}&seite=${page}`;
    const html = await respectfulFetchText(indexUrl, "de,en;q=0.8");
    const matches = [...html.matchAll(/BVerfG,\s*(\d{2}\.\d{2}\.20\d{2})\s*-\s*([^<\r\n]+)/g)];
    let sawInRange = false;
    let oldestDate: Date | undefined;

    for (const match of matches) {
      const date = match[1];
      const docket = match[2].replace(/\s+/g, " ").trim();
      const parsedDate = parseDate(date);
      if (parsedDate && (!oldestDate || parsedDate < oldestDate)) oldestDate = parsedDate;
      if (!inRange(date)) continue;

      const itemUrl = bverfgUrlFromDocket(date, docket);
      if (!itemUrl) continue;
      sawInRange = true;
      items.push({
        country: "Germany",
        sourceKey: "de-bverfg",
        url: itemUrl,
        canonicalUrl: canonicalizeUrl(itemUrl),
        title: `Beschluss vom ${germanDisplayDate(date)} - ${docket}`,
        publishedAt: date,
        contentType: "decision",
        metadata: {
          discoveryIndex: "dejure.org",
          discoveryIndexUrl: indexUrl,
          caseNumber: docket,
          collection: {
            source: BVERFG_BASE_URL,
            strategy: "cheerio",
            confidence: "medium",
            sourceUrlVerified: true,
            publishable: false,
            sourceTextAvailable: false,
            reason:
              "BVerfG /SiteGlobals/ search page is robots-disallowed, so a robots-allowed public case-number index was used only to derive the official decision detail URL.",
          },
          detailDiscoveryStrategy: "dejure-index-to-official-detail",
        },
      });
    }

    if (!sawInRange && oldestDate && oldestDate < from) break;
  }

  return items;
}

async function discoverBverfgDecisions() {
  const indexed = USE_BVERFG_EXTERNAL_INDEX
    ? await discoverBverfgFromOpenLegalData().catch((error) => {
        console.warn(`BVerfG external index discovery failed: ${error instanceof Error ? error.message : String(error)}`);
        return [] as Candidate[];
      })
    : [];
  const dejureIndexed = USE_BVERFG_DEJURE_INDEX
    ? await discoverBverfgFromDejureIndex().catch((error) => {
        console.warn(`BVerfG dejure index discovery failed: ${error instanceof Error ? error.message : String(error)}`);
        return [] as Candidate[];
      })
    : [];
  return uniqueCandidates([...bverfgSeedCandidates(), ...bverfgConfiguredDetailCandidates(), ...dejureIndexed, ...indexed]);
}

async function discoverConseilDecisions() {
  const indexXml = await respectfulFetchText(`${CONSEIL_BASE_URL}/sitemap.xml`, "fr,en;q=0.8");
  const $index = load(indexXml, { xmlMode: true });
  const years = new Set(yearsInRange().map(String));
  const sitemapUrls = $index("loc")
    .map((_, loc) => $index(loc).text().trim())
    .get()
    .filter((url) => /sitemap\.xml\?page=/.test(url));
  const items: Candidate[] = [];

  for (const sitemapUrl of sitemapUrls) {
    const xml = await respectfulFetchText(sitemapUrl, "fr,en;q=0.8");
    const $ = load(xml, { xmlMode: true });
    $("url").each((_, urlNode) => {
      const itemUrl = $(urlNode).find("loc").first().text().trim();
      const lastmod = $(urlNode).find("lastmod").first().text().trim();
      const year = itemUrl.match(/^https:\/\/www\.conseil-constitutionnel\.fr\/decision\/(20\d{2})\//)?.[1];
      if (!year || !years.has(year)) return;
      items.push({
        country: "France",
        sourceKey: "fr-conseil-constitutionnel",
        url: itemUrl,
        canonicalUrl: canonicalizeUrl(itemUrl),
        title: undefined,
        publishedAt: lastmod || undefined,
        contentType: "decision",
        metadata: {
          listingUrl: sitemapUrl,
          sitemapLastmod: lastmod || undefined,
          collection: {
            source: CONSEIL_BASE_URL,
            strategy: "sitemap",
            confidence: "medium",
            sourceUrlVerified: true,
            publishable: false,
            sourceTextAvailable: false,
            reason: "Official Conseil constitutionnel decision URL discovered from the official sitemap.",
          },
        },
      });
    });
  }

  return uniqueCandidates(items);
}

async function robotsCheck(url: string) {
  const robots = await checkRobotsAllowed(url);
  return {
    allowed: robots.allowed,
    delayMs: robotsDelayMs(robots),
    matchedRule: robots.matchedRule,
  };
}

function collectionFromMetadata(metadata?: Record<string, unknown>) {
  const collection = metadata?.collection;
  return typeof collection === "object" && collection !== null
    ? (collection as { sourceUrlVerified?: boolean; sourceTextAvailable?: boolean; publishable?: boolean })
    : undefined;
}

function isUnverifiedBverfgFetch(article: { sourceKey: string; originalTitle?: string; metadata?: Record<string, unknown> }) {
  if (article.sourceKey !== "de-bverfg") return false;
  const collection = collectionFromMetadata(article.metadata);
  return collection?.sourceUrlVerified === false || /^HTTP Status \d+/i.test(article.originalTitle ?? "");
}

async function collectSource(adapter: SourceAdapter, candidates: Candidate[], report: SourceReport) {
  report.discoveredCount = candidates.length;

  for (const candidate of candidates) {
    const diagnostics = createDiagnosticsCollector(adapter.sourceKey);
    try {
      const robots = await robotsCheck(candidate.url);
      if (!robots.allowed) {
        report.skippedRobotsCount += 1;
        report.notes.push(`robots disallowed: ${candidate.url} (${robots.matchedRule ?? "empty rule"})`);
        continue;
      }
      if (await articleExists(candidate.canonicalUrl)) {
        report.skippedExistingCount += 1;
        continue;
      }

      await sleep(Math.max(DELAY_MS, robots.delayMs));
      report.attemptedCount += 1;
      const raw = await adapter.fetchItem(candidate, { strategy: "auto", usePlaywright: false, diagnostics, limit: 1 });
      const rawWithDate = { ...raw, publishedAt: bestPublishedAt(raw, candidate) };
      const normalized = await adapter.normalize(rawWithDate);
      if (isUnverifiedBverfgFetch(normalized)) {
        report.skippedUnverifiedCount += 1;
        continue;
      }
      if (!inRange(normalized.originalPublishedAt ?? raw.publishedAt ?? candidate.publishedAt)) {
        report.skippedOutOfRangeCount += 1;
        if (report.notes.length < 10) {
          report.notes.push(
            `out of range: ${candidate.url} normalized=${normalized.originalPublishedAt ?? "none"} raw=${raw.publishedAt ?? "none"} candidate=${candidate.publishedAt ?? "none"} title=${raw.title ?? candidate.title ?? "none"}`,
          );
        }
        continue;
      }
      if (await articleExists(normalized.canonicalUrl)) {
        report.skippedExistingCount += 1;
        continue;
      }
      if (await articleExistsByNormalizedContent(normalized)) {
        report.skippedDuplicateCount += 1;
        continue;
      }
      const inserted = await insertNormalizedArticle(normalized);
      if (!inserted) continue;
      report.insertedCount += 1;
      report.rawBytes += Buffer.byteLength(normalized.rawText ?? "", "utf8");
      report.cleanedBytes += Buffer.byteLength(normalized.cleanedText ?? "", "utf8");
    } catch (error) {
      report.failedCount += 1;
      report.errors.push(`${candidate.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function main() {
  configureRespectfulDefaults();
  const discoveries = {
    "us-scotus": SOURCES.has("us-scotus") ? await discoverScotusOpinions() : [],
    "de-bverfg": SOURCES.has("de-bverfg") ? await discoverBverfgDecisions() : [],
    "fr-conseil-constitutionnel": SOURCES.has("fr-conseil-constitutionnel") ? await discoverConseilDecisions() : [],
  };
  const reports = [
    sourceReport("us-scotus", "United States"),
    sourceReport("de-bverfg", "Germany"),
    sourceReport("fr-conseil-constitutionnel", "France"),
  ].filter((report) => SOURCES.has(report.sourceKey));

  for (const report of reports) {
    const adapter = getSourceAdapter(report.sourceKey);
    if (!adapter) throw new Error(`Unknown source: ${report.sourceKey}`);
    const sourceCandidates = discoveries[report.sourceKey as keyof typeof discoveries];
    await collectSource(adapter, MAX_CANDIDATES_PER_SOURCE > 0 ? sourceCandidates.slice(0, MAX_CANDIDATES_PER_SOURCE) : sourceCandidates, report);
  }

  console.log(JSON.stringify({ from: FROM, to: TO, delayMs: DELAY_MS, reports }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
