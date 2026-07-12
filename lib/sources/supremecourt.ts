import { load } from "cheerio";
import { addDiagnosticAttempt, diagnosticFromResponse } from "@/lib/crawler/diagnostics";
import { crawlUrl } from "@/lib/crawler/http-client";
import { checkRobotsAllowed, robotsDelayMs, type RobotsResult } from "@/lib/crawler/robots";
import { fetchRawItem } from "@/lib/ingest/fetch";
import { normalizeRawArticle } from "@/lib/ingest/normalize";
import type { SourceDiscoveryOptions } from "@/lib/crawler/types";
import type { DiscoveredItem, RawArticle, SourceAdapter } from "@/lib/sources/types";
import { canonicalizeUrl } from "@/lib/utils/canonical-url";

const BASE_URL = "https://www.supremecourt.gov";
const SCOTUS_MAX_CONCURRENCY = 1;

function currentScotusTerm() {
  const now = new Date();
  const termStartYear = now.getUTCMonth() >= 9 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return String(termStartYear).slice(-2);
}

function addRobotsDiagnostic(url: string, robots: RobotsResult, options?: SourceDiscoveryOptions) {
  addDiagnosticAttempt(options?.diagnostics, {
    url,
    strategy: "robots",
    status: robots.status,
    robotsUrl: robots.robotsUrl,
    robotsAllowed: robots.allowed,
    robotsMatchedRule: robots.matchedRule,
    robotsMatchedDirective: robots.matchedDirective,
    robotsCrawlDelaySeconds: robots.crawlDelaySeconds,
    robotsUserAgent: robots.userAgent,
    errorCode: robots.allowed ? undefined : "ROBOTS_DISALLOW",
    errorMessage: robots.allowed ? undefined : `Disallowed by robots.txt rule ${robots.matchedRule ?? "(empty)"}`,
  });
}

async function fetchHtml(url: string, options?: SourceDiscoveryOptions) {
  await options?.checkpoint?.();
  if (options?.signal?.aborted) throw options.signal.reason;
  const robots = await checkRobotsAllowed(url, options);
  addRobotsDiagnostic(url, robots, options);
  if (!robots.allowed) {
    throw new Error(`SCOTUS listing fetch disallowed by robots.txt rule ${robots.matchedRule ?? "(empty)"}`);
  }

  const response = await crawlUrl({
    url,
    rateLimitDelayMs: robotsDelayMs(robots),
    signal: options?.signal,
    checkpoint: options?.checkpoint,
  });
  addDiagnosticAttempt(options?.diagnostics, diagnosticFromResponse(response));
  if (response.status >= 400 || !response.text) {
    throw new Error(`SCOTUS listing fetch failed: ${response.status} ${response.diagnostics?.errorMessage ?? "No body"}`);
  }

  return response.text;
}

async function discoverScotusListings(options?: SourceDiscoveryOptions) {
  const term = currentScotusTerm();
  const listings = [
    {
      url: `${BASE_URL}/opinions/slipopinion/${term}`,
      discover: discoverOpinions,
    },
  ];
  const items: DiscoveredItem[] = [];

  for (const listing of listings) {
    try {
      const html = await fetchHtml(listing.url, options);
      items.push(...listing.discover(html, listing.url));
    } catch (error) {
      addDiagnosticAttempt(options?.diagnostics, {
        url: listing.url,
        strategy: "official-listing",
        errorCode: error instanceof Error ? error.name : "SCOTUS_LISTING_ERROR",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return items;
}

function discoverOpinions(html: string, listingUrl: string): DiscoveredItem[] {
  const $ = load(html);
  const items: DiscoveredItem[] = [];

  $("table.table tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 4) return;

    const publishedAt = $(cells[1]).text().trim();
    const docket = $(cells[2]).text().trim();
    const link = $(cells[3]).find("a[href$='.pdf']").first();
    const href = link.attr("href");
    if (!href) return;

    const url = new URL(href, BASE_URL).toString();
    const title = link.text().replace(/\s+/g, " ").trim();
    const syllabus = link.attr("title");
    items.push({
      sourceKey: "us-scotus",
      url,
      canonicalUrl: canonicalizeUrl(url),
      title,
      publishedAt,
      contentType: "opinion",
      metadata: {
        docket,
        syllabus,
        listingUrl,
        officialListingCollected: true,
        officialPdfUrlDiscovered: true,
        collection: {
          source: BASE_URL,
          strategy: "official-listing",
          confidence: "medium",
          sourceUrlVerified: true,
          sourceTextAvailable: false,
          publishable: false,
          reason: "Official SCOTUS listing metadata collected; PDF source text must pass robots.txt before automatic summarization.",
        },
      },
    });
  });

  return items;
}

export const supremeCourtAdapter: SourceAdapter = {
  sourceKey: "us-scotus",
  displayName: "Supreme Court of the United States",
  jurisdiction: "United States",
  baseUrl: BASE_URL,
  defaultLanguage: "en",

  async discover(options) {
    addDiagnosticAttempt(options?.diagnostics, {
      strategy: "official-listing",
      maxConcurrency: SCOTUS_MAX_CONCURRENCY,
      errorMessage: "SCOTUS official source discovery runs with maxConcurrency=1 and per-URL robots.txt checks.",
    });
    return discoverScotusListings(options);
  },

  fetchItem(item: DiscoveredItem, options?: SourceDiscoveryOptions): Promise<RawArticle> {
    return fetchRawItem(item, options);
  },

  async normalize(raw: RawArticle) {
    return normalizeRawArticle(raw, this);
  },
};
