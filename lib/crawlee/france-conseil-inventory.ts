import { load } from "cheerio";
import { assertCrawlerExecution, checkpointCrawlerExecution } from "@/lib/crawler/cancellation";
import { addDiagnosticAttempt, createDiagnosticsCollector } from "@/lib/crawler/diagnostics";
import { respectRateLimit } from "@/lib/crawler/rate-limit";
import { checkRobotsAllowed, robotsDelayMs, type RobotsResult } from "@/lib/crawler/robots";
import { governedBufferedFetch } from "@/lib/crawler/request-governor";
import type { CrawlerDiagnosticsCollector, CrawlerExecutionHooks } from "@/lib/crawler/types";
import { crawlerUserAgent } from "@/lib/crawler/user-agents";
import {
  franceConseilDocumentType,
  franceConseilScope,
  type FranceConseilDocumentType,
} from "@/lib/backfill/france-scope";
import { CONSEIL_BASE_URL } from "@/lib/crawlee/france-spider";

export interface FranceConseilInventoryItem {
  stableItemKey: string;
  sourceRecordId: string;
  discoveredUrl: string;
  documentType: FranceConseilDocumentType;
  decisionDateHint: string | null;
  title: string;
}

export interface FranceConseilInventoryPage {
  items: FranceConseilInventoryItem[];
  expectedCount: number | null;
  hasNextPage: boolean;
}

export interface FranceConseilInventoryResult {
  sourceKey: "fr-conseil-constitutionnel";
  year: number;
  documentType: FranceConseilDocumentType;
  items: FranceConseilInventoryItem[];
  pageCount: number;
  expectedCount: number;
  coverageEvidence: Record<string, unknown>;
}

const FRENCH_MONTHS: Record<string, number> = {
  janvier: 1,
  fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  decembre: 12,
};

const robotsByOrigin = new Map<string, RobotsResult>();

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function cleanFrenchText(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizedFrenchText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00a0/g, " ");
}

function validDateOnly(yearValue: string, month: number, dayValue: string) {
  const year = Number(yearValue);
  const day = Number(dayValue);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${yearValue}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseFranceConseilDecisionDate(title: string) {
  const normalized = normalizedFrenchText(title).toLowerCase();
  const match = normalized.match(/\bdu\s+(1er|\d{1,2})\s+([a-z]+)\s+(\d{4})\b/);
  if (!match) return null;
  const month = FRENCH_MONTHS[match[2]];
  if (!month) return null;
  return validDateOnly(match[3], month, match[1] === "1er" ? "1" : match[1]);
}

function decisionPathIdentity(href: string) {
  const match = href.match(/^\/decision\/(\d{4})\/([^/?#]+)\.(?:html?|htm)$/i);
  return match ? { pathYear: Number(match[1]), sourceRecordId: match[2] } : null;
}

function titleMatchesType(title: string, documentType: FranceConseilDocumentType) {
  const normalized = normalizedFrenchText(title).toUpperCase();
  return documentType === "QPC" ? /\bQPC\b/.test(normalized) : /\bDC\b/.test(normalized);
}

function expectedCountFromPage(html: string) {
  const $ = load(html);
  const activeTypeCount = $("[data-drupal-facet-id='page_les_decisions_type'] a.is-active")
    .first()
    .attr("data-drupal-facet-item-count");
  if (activeTypeCount && /^\d+$/.test(activeTypeCount)) return Number(activeTypeCount);

  const viewText = normalizedFrenchText($(".view-recherche .view-header, .view-recherche > .view-empty").first().text());
  const count = viewText.match(/\b(\d+)\s+resultats?\b/i)?.[1];
  return count ? Number(count) : null;
}

export function parseFranceConseilInventoryPage(
  html: string,
  input: { year: number; documentType: FranceConseilDocumentType },
): FranceConseilInventoryPage {
  const $ = load(html);
  const items = new Map<string, FranceConseilInventoryItem>();
  $("a[href^='/decision/']").each((_, anchor) => {
    const href = $(anchor).attr("href") ?? "";
    const identity = decisionPathIdentity(href);
    if (!identity || identity.pathYear !== input.year) return;
    const title = cleanFrenchText($(anchor).attr("title") ?? $(anchor).text());
    if (!title || !titleMatchesType(title, input.documentType)) return;
    const discoveredUrl = new URL(href, CONSEIL_BASE_URL).toString();
    const stableItemKey = `conseil:${identity.sourceRecordId.toLowerCase()}`;
    if (items.has(stableItemKey)) return;
    items.set(stableItemKey, {
      stableItemKey,
      sourceRecordId: identity.sourceRecordId,
      discoveredUrl,
      documentType: input.documentType,
      decisionDateHint: parseFranceConseilDecisionDate(title),
      title,
    });
  });
  return {
    items: [...items.values()],
    expectedCount: expectedCountFromPage(html),
    hasNextPage: $("a[rel='next']").length > 0,
  };
}

function annualTypeUrl(year: number, documentType: FranceConseilDocumentType, page: number) {
  const url = new URL(`/les-decisions/annee/${year}/type/${documentType.toLowerCase()}`, CONSEIL_BASE_URL);
  url.searchParams.set("items_per_page", "100");
  url.searchParams.set("sort_by", "cc_date_1");
  if (page > 0) url.searchParams.set("page", String(page));
  return url.toString();
}

async function fetchInventoryPage(
  url: string,
  diagnostics: CrawlerDiagnosticsCollector,
  hooks: CrawlerExecutionHooks,
) {
  await checkpointCrawlerExecution(hooks);
  const origin = new URL(url).origin;
  let robots = robotsByOrigin.get(origin);
  if (!robots) {
    robots = await checkRobotsAllowed(url, hooks);
    robotsByOrigin.set(origin, robots);
  }
  if (!robots.allowed) throw new Error("France Conseil robots policy disallows annual decision inventory.");
  await respectRateLimit(url, robotsDelayMs(robots, envNumber("FRANCE_REQUEST_DELAY_MS", 3000)), hooks.signal);
  await checkpointCrawlerExecution(hooks);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), envNumber("FRANCE_TIMEOUT_MS", 90_000));
  try {
    const signals = [hooks.signal, controller.signal].filter((signal): signal is AbortSignal => Boolean(signal));
    const response = await governedBufferedFetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr,en;q=0.8,ko;q=0.5",
        "User-Agent": crawlerUserAgent(),
      },
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    }, hooks);
    const html = await response.text();
    await checkpointCrawlerExecution(hooks);
    addDiagnosticAttempt(diagnostics, {
      sourceKey: "fr-conseil-constitutionnel",
      url,
      finalUrl: response.url,
      strategy: "cheerio",
      status: response.status,
      contentType: response.headers.get("content-type") ?? undefined,
      htmlLength: html.length,
      result: response.ok ? "success" : "failed",
    });
    if (!response.ok || !/<(?:html|!DOCTYPE)/i.test(html)) {
      throw new Error(`France Conseil inventory returned invalid HTML (${response.status}).`);
    }
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverFranceConseilInventory(input: {
  year: number;
  documentType: FranceConseilDocumentType;
  maxPages?: number;
  currentYear?: number;
  diagnostics?: CrawlerDiagnosticsCollector;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
  requestGovernor?: CrawlerExecutionHooks["requestGovernor"];
}): Promise<FranceConseilInventoryResult> {
  const scope = franceConseilScope(input.year, input.documentType, input.currentYear);
  const documentType = franceConseilDocumentType(scope.documentType);
  if (!documentType) throw new Error("case_backfill.france_document_type_not_supported");
  const maxPages = input.maxPages ?? envNumber("FRANCE_BACKFILL_MAX_PAGES", 100);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) {
    throw new Error("France Conseil inventory maxPages is invalid.");
  }
  const diagnostics = input.diagnostics ?? createDiagnosticsCollector("fr-conseil-constitutionnel");
  const hooks: CrawlerExecutionHooks = {
    signal: input.signal,
    checkpoint: input.checkpoint,
    requestGovernor: input.requestGovernor,
  };
  const items = new Map<string, FranceConseilInventoryItem>();
  let expectedCount: number | null = null;
  let pageCount = 0;
  let exhausted = false;

  for (let page = 0; page < maxPages; page += 1) {
    assertCrawlerExecution(hooks);
    const url = annualTypeUrl(scope.year, documentType, page);
    const parsed = parseFranceConseilInventoryPage(await fetchInventoryPage(url, diagnostics, hooks), {
      year: scope.year,
      documentType,
    });
    pageCount += 1;
    if (parsed.expectedCount === null) throw new Error("France Conseil inventory expected count is missing.");
    if (expectedCount !== null && expectedCount !== parsed.expectedCount) {
      throw new Error("France Conseil inventory count changed during pagination.");
    }
    expectedCount = parsed.expectedCount;
    for (const item of parsed.items) items.set(item.stableItemKey, item);
    if (!parsed.hasNextPage) {
      exhausted = true;
      break;
    }
  }

  if (!exhausted) throw new Error("France Conseil inventory pagination did not exhaust within maxPages.");
  if (expectedCount === null || items.size !== expectedCount) {
    throw new Error(`France Conseil inventory count mismatch: expected ${expectedCount ?? "unknown"}, discovered ${items.size}.`);
  }

  return {
    sourceKey: "fr-conseil-constitutionnel",
    year: scope.year,
    documentType,
    items: [...items.values()].sort((left, right) => left.stableItemKey.localeCompare(right.stableItemKey)),
    pageCount,
    expectedCount,
    coverageEvidence: {
      method: "official_conseil_annual_type_pagination",
      officialUrl: annualTypeUrl(scope.year, documentType, 0),
      scopeFrom: scope.scopeFrom,
      scopeTo: scope.scopeTo,
      documentType,
      expectedCount,
      expectedCountBasis: "official_active_type_facet",
      discoveredCount: items.size,
      exhausted: true,
      pageCount,
      qpc360Crosscheck: "not_in_primary_manifest",
    },
  };
}
