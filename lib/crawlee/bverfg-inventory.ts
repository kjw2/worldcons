import { load } from "cheerio";
import { assertCrawlerExecution, checkpointCrawlerExecution } from "@/lib/crawler/cancellation";
import { addDiagnosticAttempt, createDiagnosticsCollector } from "@/lib/crawler/diagnostics";
import { respectRateLimit } from "@/lib/crawler/rate-limit";
import { governedBoundedFetch } from "@/lib/crawler/request-governor";
import { checkRobotsAllowed, robotsDelayMs, type RobotsResult } from "@/lib/crawler/robots";
import type { CrawlerDiagnosticsCollector, CrawlerExecutionHooks } from "@/lib/crawler/types";
import { crawlerHeaders } from "@/lib/crawler/user-agents";
import { germanyBverfgYearScope } from "@/lib/backfill/germany-scope";
import {
  BVERFG_BASE_URL,
  bverfgOfficialUrlCandidatesFromDocket,
} from "@/lib/crawlee/bverfg-spider";
import { createHash } from "@/lib/utils/hash";
import type { CaseBackfillEnumerationArtifact } from "@/lib/backfill/types";

export const BVERFG_DEJURE_INDEX_URL = "https://dejure.org/dienste/rechtsprechung?gericht=BVerfG";
const BVERFG_DECISIONS_URL = `${BVERFG_BASE_URL}/DE/Entscheidungen/entscheidungen_node.html`;
const MAX_INDEX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface BverfgInventoryItem {
  stableItemKey: string;
  sourceRecordId: null;
  discoveredUrl: string;
  documentType: "DECISION";
  decisionDateHint: string;
  title: string;
  inventoryMetadata: Record<string, unknown>;
}

export interface BverfgInventoryPage {
  items: BverfgInventoryItem[];
  newestDecisionDate: string | null;
  oldestDecisionDate: string | null;
  observedLastPage: number | null;
  hasNextPage: boolean;
  listingFingerprint: string;
}

export interface BverfgInventoryResult {
  sourceKey: "de-bverfg";
  year: number;
  documentType: "DECISION";
  items: BverfgInventoryItem[];
  pageCount: number;
  requestCount: number;
  expectedCount: null;
  expectedCountBasis: null;
  enumerationArtifacts: CaseBackfillEnumerationArtifact[];
  coverageEvidence: Record<string, unknown>;
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function isoDateFromGerman(value: string) {
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() + 1 !== Number(month)
    || date.getUTCDate() !== Number(day)
  ) return null;
  return `${year}-${month}-${day}`;
}

function cleanText(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizedDocketKey(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function indexPageUrl(page: number) {
  if (page === 1) return BVERFG_DEJURE_INDEX_URL;
  const url = new URL(BVERFG_DEJURE_INDEX_URL);
  url.searchParams.set("seite", String(page));
  return url.toString();
}

function enumerationArtifact(
  html: string,
  parsed: BverfgInventoryPage,
  page: number,
  artifactKind: CaseBackfillEnumerationArtifact["artifactKind"],
  scopeFrom: string,
  scopeTo: string,
): CaseBackfillEnumerationArtifact {
  const scopedItems = parsed.items.filter(
    (item) => item.decisionDateHint >= scopeFrom && item.decisionDateHint <= scopeTo,
  );
  return {
    providerKey: "dejure.org",
    artifactKind,
    sequenceNumber: page,
    requestUrl: indexPageUrl(page),
    responseHash: createHash(html, 64),
    recordManifestHash: parsed.listingFingerprint,
    recordCount: parsed.items.length,
    newestDecisionDate: parsed.newestDecisionDate,
    oldestDecisionDate: parsed.oldestDecisionDate,
    observedLastPage: parsed.observedLastPage,
    safeDetails: {
      page,
      scopedRecordCount: scopedItems.length,
      resolvedOfficialUrlCount: parsed.items.filter((item) => (
        Array.isArray(item.inventoryMetadata.officialUrlCandidates)
        && item.inventoryMetadata.officialUrlCandidates.length > 0
      )).length,
      storesExternalText: false,
    },
  };
}

function observedLastPage($: ReturnType<typeof load>) {
  let lastPage = 1;
  $("a[href*='gericht=BVerfG'][href*='seite=']").each((_, anchor) => {
    const href = $(anchor).attr("href");
    if (!href) return;
    try {
      const page = Number(new URL(href, BVERFG_DEJURE_INDEX_URL).searchParams.get("seite"));
      if (Number.isInteger(page) && page > lastPage) lastPage = page;
    } catch {
      // Ignore malformed navigation links; decision rows remain independently parseable.
    }
  });
  return lastPage > 1 ? lastPage : null;
}

export function parseBverfgDejureInventoryPage(html: string, page: number): BverfgInventoryPage {
  const $ = load(html);
  const items = new Map<string, BverfgInventoryItem>();
  $("a[data-djo_karte][href]").each((_, anchor) => {
    const label = cleanText($(anchor).text());
    const match = label.match(/^BVerfG,\s*(\d{2}\.\d{2}\.\d{4})\s*-\s*(.+)$/i);
    if (!match) return;
    const decisionDate = isoDateFromGerman(match[1]);
    const docket = cleanText(match[2]);
    const docketKey = normalizedDocketKey(docket);
    if (!decisionDate || !docketKey) return;

    const externalHref = $(anchor).attr("href") ?? "";
    const externalIndexUrl = new URL(externalHref, BVERFG_DEJURE_INDEX_URL).toString();
    const officialUrlCandidates = bverfgOfficialUrlCandidatesFromDocket(match[1], docket);
    const discoveredUrl = officialUrlCandidates[0] ?? BVERFG_DECISIONS_URL;
    const stableItemKey = `dejure:${decisionDate}:${docketKey}`;
    if (items.has(stableItemKey)) return;
    const descriptiveTitle = cleanText($(anchor).attr("title") ?? "");
    items.set(stableItemKey, {
      stableItemKey,
      sourceRecordId: null,
      discoveredUrl,
      documentType: "DECISION",
      decisionDateHint: decisionDate,
      title: descriptiveTitle || label,
      inventoryMetadata: {
        discoveryIndex: "dejure.org",
        discoveryIndexPage: page,
        discoveryIndexUrl: indexPageUrl(page),
        discoveryRecordUrl: externalIndexUrl,
        decisionDate,
        docket,
        docketKey,
        officialUrlCandidates,
        officialUrlResolverVersion: 2,
        officialUrlResolved: officialUrlCandidates.length > 0,
        sourceUrlVerified: false,
        authorityVerificationRequired: true,
      },
    });
  });

  const sorted = [...items.values()].sort((left, right) => {
    const dateOrder = right.decisionDateHint.localeCompare(left.decisionDateHint);
    return dateOrder || left.stableItemKey.localeCompare(right.stableItemKey);
  });
  const dates = sorted.map((item) => item.decisionDateHint);
  const navigationLastPage = observedLastPage($);
  return {
    items: sorted,
    newestDecisionDate: dates[0] ?? null,
    oldestDecisionDate: dates.at(-1) ?? null,
    observedLastPage: navigationLastPage,
    hasNextPage: navigationLastPage === null ? false : page < navigationLastPage,
    listingFingerprint: createHash(
      sorted.map((item) => item.stableItemKey).sort().join("\n"),
      64,
    ),
  };
}

async function fetchInventoryPage(
  url: string,
  robots: RobotsResult,
  diagnostics: CrawlerDiagnosticsCollector,
  hooks: CrawlerExecutionHooks,
) {
  await checkpointCrawlerExecution(hooks);
  await respectRateLimit(
    url,
    robotsDelayMs(robots, envNumber("BVERFG_BACKFILL_INDEX_DELAY_MS", 30_000)),
    hooks.signal,
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    envNumber("BVERFG_BACKFILL_INDEX_TIMEOUT_MS", 60_000),
  );
  try {
    const signals = [hooks.signal, controller.signal].filter((signal): signal is AbortSignal => Boolean(signal));
    const response = await governedBoundedFetch(url, {
      headers: crawlerHeaders({
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "de,en;q=0.8,ko;q=0.5",
      }),
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    }, MAX_INDEX_RESPONSE_BYTES, hooks);
    const html = await response.text();
    addDiagnosticAttempt(diagnostics, {
      sourceKey: "de-bverfg",
      url,
      finalUrl: response.url,
      strategy: "cheerio",
      status: response.status,
      contentType: response.headers.get("content-type") ?? undefined,
      htmlLength: html.length,
      result: response.ok ? "success" : "failed",
    });
    if (!response.ok || !/<(?:html|!doctype)/i.test(html)) {
      throw new Error(`BVerfG external index returned invalid HTML (${response.status}).`);
    }
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverBverfgInventory(input: {
  year: number;
  currentYear?: number;
  maxPages?: number;
  diagnostics?: CrawlerDiagnosticsCollector;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
  requestGovernor?: CrawlerExecutionHooks["requestGovernor"];
  fetchPage?: (url: string, page: number) => Promise<string>;
}): Promise<BverfgInventoryResult> {
  const scope = germanyBverfgYearScope(input.year, input.currentYear);
  const maxPages = input.maxPages ?? envNumber("BVERFG_BACKFILL_MAX_INDEX_PAGES", 500);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) {
    throw new Error("BVerfG inventory maxPages is invalid.");
  }
  const diagnostics = input.diagnostics ?? createDiagnosticsCollector("de-bverfg");
  const hooks: CrawlerExecutionHooks = {
    signal: input.signal,
    checkpoint: input.checkpoint,
    requestGovernor: input.requestGovernor,
  };
  const fetchPage = input.fetchPage;
  let robots: RobotsResult | null = null;
  const loadPage = async (page: number) => {
    const url = indexPageUrl(page);
    if (fetchPage) return fetchPage(url, page);
    robots ??= await checkRobotsAllowed(url, hooks);
    if (!robots.allowed) throw new Error("dejure.org robots policy disallows the BVerfG listing.");
    return fetchInventoryPage(url, robots, diagnostics, hooks);
  };

  const inventory = new Map<string, BverfgInventoryItem>();
  const enumerationArtifacts: CaseBackfillEnumerationArtifact[] = [];
  const firstPageHtml = await loadPage(1);
  const firstPage = parseBverfgDejureInventoryPage(firstPageHtml, 1);
  if (firstPage.items.length === 0) throw new Error("BVerfG external index first page is empty.");
  let pageCount = 0;
  let requestCount = 1;
  let observedLastPage = firstPage.observedLastPage;
  let observedLastPageMinimum = firstPage.observedLastPage;
  let observedLastPageMaximum = firstPage.observedLastPage;
  let crossedOlderBoundary = false;
  let sawScopeItem = false;

  for (let page = 1; page <= maxPages; page += 1) {
    assertCrawlerExecution(hooks);
    const html = page === 1 ? firstPageHtml : await loadPage(page);
    const parsed = page === 1 ? firstPage : parseBverfgDejureInventoryPage(html, page);
    if (page > 1) requestCount += 1;
    enumerationArtifacts.push(enumerationArtifact(
      html,
      parsed,
      page,
      "page",
      scope.scopeFrom,
      scope.scopeTo,
    ));
    pageCount = page;
    if (parsed.items.length === 0) {
      throw new Error(`BVerfG external index page ${page} is empty before the annual boundary.`);
    }
    if (parsed.observedLastPage !== null) {
      observedLastPage = Math.max(observedLastPage ?? 0, parsed.observedLastPage);
      observedLastPageMinimum = Math.min(observedLastPageMinimum ?? parsed.observedLastPage, parsed.observedLastPage);
      observedLastPageMaximum = Math.max(observedLastPageMaximum ?? parsed.observedLastPage, parsed.observedLastPage);
    }
    for (const item of parsed.items) {
      if (item.decisionDateHint >= scope.scopeFrom && item.decisionDateHint <= scope.scopeTo) {
        sawScopeItem = true;
        inventory.set(item.stableItemKey, item);
      }
    }
    if (parsed.oldestDecisionDate && parsed.oldestDecisionDate < scope.scopeFrom) {
      crossedOlderBoundary = true;
      break;
    }
    if (!parsed.hasNextPage) break;
  }

  if (!crossedOlderBoundary) {
    throw new Error("BVerfG external index did not cross the requested annual boundary within maxPages.");
  }
  if (!sawScopeItem) {
    throw new Error("BVerfG external index crossed the annual boundary without a scoped decision.");
  }

  const firstPageProbeHtml = await loadPage(1);
  const firstPageProbe = parseBverfgDejureInventoryPage(firstPageProbeHtml, 1);
  requestCount += 1;
  if (
    firstPageProbe.listingFingerprint !== firstPage.listingFingerprint
    || firstPageProbe.observedLastPage !== firstPage.observedLastPage
  ) {
    throw new Error("BVerfG external index changed during pagination.");
  }
  enumerationArtifacts.push(enumerationArtifact(
    firstPageProbeHtml,
    firstPageProbe,
    1,
    "boundary_probe",
    scope.scopeFrom,
    scope.scopeTo,
  ));

  const items = [...inventory.values()].sort((left, right) => left.stableItemKey.localeCompare(right.stableItemKey));
  const unresolvedOfficialUrlCount = items.filter((item) => {
    const candidates = item.inventoryMetadata.officialUrlCandidates;
    return !Array.isArray(candidates) || candidates.length === 0;
  }).length;
  return {
    sourceKey: "de-bverfg",
    year: scope.year,
    documentType: "DECISION",
    items,
    pageCount,
    requestCount,
    expectedCount: null,
    expectedCountBasis: null,
    enumerationArtifacts,
    coverageEvidence: {
      method: "external_index_dejure_paged_listing",
      externalIndexUrl: BVERFG_DEJURE_INDEX_URL,
      officialAuthorityUrl: BVERFG_DECISIONS_URL,
      scopeFrom: scope.scopeFrom,
      scopeTo: scope.scopeTo,
      documentType: "DECISION",
      coverageAssurance: "external_index_assisted",
      officialCorpusCoverageClaimed: false,
      discoveredCount: items.length,
      unresolvedOfficialUrlCount,
      pageCount,
      requestCount,
      observedLastPage,
      observedLastPageMinimum,
      observedLastPageMaximum,
      crossedOlderBoundary: true,
      firstPageProbeStable: true,
      firstPageFingerprint: firstPage.listingFingerprint,
    },
  };
}
