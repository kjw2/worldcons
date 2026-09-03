import { createHash } from "node:crypto";
import { load } from "cheerio";
import { crawlUrl } from "@/lib/crawler/http-client";
import { checkRobotsAllowed, robotsDelayMs, type RobotsResult } from "@/lib/crawler/robots";
import type { CrawlerExecutionHooks, CrawlResponse } from "@/lib/crawler/types";
import {
  classifyUsCaseCitation,
  normalizeUsCaseCitation,
  type ConstitutionAnnotatedCandidate,
} from "@/lib/backfill/us-constitution-annotated";

export interface UsReportsCitationParts {
  volume: number;
  page: number;
  year: number | null;
  normalizedCitation: string;
}

export interface GovInfoAuthorityResolution {
  status: "verified" | "not_found" | "mismatch" | "blocked";
  citation: string;
  officialCaseName: string | null;
  detailsUrl: string;
  pdfUrl: string | null;
  payloadHash: string | null;
  observedAt: string;
  blocking: string[];
}

export interface GovInfoResolverDependencies {
  checkRobotsAllowed?: typeof checkRobotsAllowed;
  crawlUrl?: typeof crawlUrl;
  now?: () => Date;
}

const GOVINFO_ORIGIN = "https://www.govinfo.gov";

export function parseUsReportsCitation(value: string): UsReportsCitationParts | null {
  const normalized = normalizeUsCaseCitation(value);
  const match = normalized.match(/^(\d+)\s+U\.\s*S\.\s+(?:\([^)]+\)\s+)?(\d+)(?:\s+\((\d{4})\))?$/i);
  if (!match) return null;
  const volume = Number(match[1]);
  const page = Number(match[2]);
  const year = match[3] ? Number(match[3]) : null;
  if (!Number.isInteger(volume) || volume < 2 || volume > 999 || !Number.isInteger(page) || page < 1 || page > 99999) {
    return null;
  }
  return { volume, page, year, normalizedCitation: normalized };
}

export function govInfoUsReportsUrls(parts: Pick<UsReportsCitationParts, "volume" | "page">) {
  const packageId = `USREPORTS-${parts.volume}`;
  const granuleId = `${packageId}-${parts.page}`;
  return {
    detailsUrl: `${GOVINFO_ORIGIN}/app/details/${packageId}/${granuleId}`,
    pdfUrl: `${GOVINFO_ORIGIN}/content/pkg/${packageId}/pdf/${granuleId}.pdf`,
  };
}

function normalizedParty(value: string) {
  return value
    .toLowerCase()
    .replace(/\bet\s+al\.?\b/g, " ")
    .replace(/\b(?:in\s+re|ex\s+rel)\.?\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !["the", "of", "and"].includes(token));
}

function partyAnchors(value: string) {
  const parts = value.split(/\s+v(?:s)?\.?\s+/i);
  if (parts.length < 2) return [];
  return [normalizedParty(parts[0])[0], normalizedParty(parts[1])[0]].filter((value): value is string => Boolean(value));
}

function officialGovInfoUrl(value: string, expectedPath: string) {
  try {
    const url = new URL(value, GOVINFO_ORIGIN);
    return url.protocol === "https:" && url.hostname === "www.govinfo.gov" && url.pathname === expectedPath;
  } catch {
    return false;
  }
}

export function parseGovInfoUsReportsDetails(
  html: string,
  candidate: Pick<ConstitutionAnnotatedCandidate, "caseName" | "citation">,
): Omit<GovInfoAuthorityResolution, "observedAt"> {
  const citation = parseUsReportsCitation(candidate.citation);
  if (!citation) throw new Error("us_authority.invalid_us_reports_citation");
  const urls = govInfoUsReportsUrls(citation);
  const $ = load(html);
  const officialTitle = ($('meta[name="dc.title"]').attr("content") || $("h2.article-title").first().text())
    .replace(/\s+/g, " ")
    .trim();
  const titleCitation = officialTitle
    ? officialTitle.match(/\b\d+\s+U\.\s*S\.\s+(?:\([^)]+\)\s+)?\d+(?:\s+\(\d{4}\))?/i)?.[0]
    : null;
  const officialCaseName = titleCitation
    ? officialTitle.slice(0, officialTitle.toLowerCase().indexOf(titleCitation.toLowerCase())).replace(/[\s,;]+$/, "").trim()
    : null;
  const blocking: string[] = [];
  if (!titleCitation || normalizeUsCaseCitation(titleCitation).toLowerCase() !== citation.normalizedCitation.toLowerCase()) {
    blocking.push("official_citation_mismatch");
  }
  const anchors = partyAnchors(candidate.caseName);
  const officialTokens = new Set(normalizedParty(officialCaseName ?? ""));
  if (anchors.length < 2 || anchors.some((anchor) => !officialTokens.has(anchor))) {
    blocking.push("official_case_name_mismatch");
  }
  const expectedPdfPath = new URL(urls.pdfUrl).pathname;
  const discoveredPdf = $("a[href]").toArray()
    .map((anchor) => $(anchor).attr("href") ?? "")
    .find((href) => officialGovInfoUrl(href, expectedPdfPath));
  if (!discoveredPdf) blocking.push("official_pdf_link_missing");
  return {
    status: blocking.length === 0 ? "verified" : "mismatch",
    citation: citation.normalizedCitation,
    officialCaseName,
    detailsUrl: urls.detailsUrl,
    pdfUrl: discoveredPdf ? urls.pdfUrl : null,
    payloadHash: createHash("sha256").update(html).digest("hex"),
    blocking,
  };
}

function finalDetailsUrlAllowed(value: string, expected: string) {
  try {
    const actual = new URL(value);
    const wanted = new URL(expected);
    return actual.protocol === "https:" && actual.hostname === "www.govinfo.gov" && actual.pathname === wanted.pathname;
  } catch {
    return false;
  }
}

export async function resolveGovInfoUsReportsAuthority(
  candidate: Pick<ConstitutionAnnotatedCandidate, "caseName" | "citation" | "courtClassification">,
  hooks: CrawlerExecutionHooks = {},
  dependencies: GovInfoResolverDependencies = {},
): Promise<GovInfoAuthorityResolution> {
  const now = dependencies.now ?? (() => new Date());
  const observedAt = now().toISOString();
  if (candidate.courtClassification !== "scotus_candidate" || classifyUsCaseCitation(candidate.citation) !== "scotus_candidate") {
    throw new Error("us_authority.scotus_candidate_required");
  }
  const citation = parseUsReportsCitation(candidate.citation);
  if (!citation) throw new Error("us_authority.invalid_us_reports_citation");
  const { detailsUrl } = govInfoUsReportsUrls(citation);
  const robots: RobotsResult = await (dependencies.checkRobotsAllowed ?? checkRobotsAllowed)(detailsUrl, hooks);
  if (robots.status !== 200 || !robots.allowed) {
    return {
      status: "blocked",
      citation: citation.normalizedCitation,
      officialCaseName: null,
      detailsUrl,
      pdfUrl: null,
      payloadHash: null,
      observedAt,
      blocking: [robots.status === 200 ? "robots_disallowed" : "robots_unavailable"],
    };
  }
  const response: CrawlResponse = await (dependencies.crawlUrl ?? crawlUrl)({
    url: detailsUrl,
    rateLimitDelayMs: robotsDelayMs(robots, 1000),
    signal: hooks.signal,
    checkpoint: hooks.checkpoint,
  });
  if (response.status === 404) {
    return {
      status: "not_found",
      citation: citation.normalizedCitation,
      officialCaseName: null,
      detailsUrl,
      pdfUrl: null,
      payloadHash: null,
      observedAt,
      blocking: ["official_granule_not_found"],
    };
  }
  if (response.status !== 200 || !response.html || !finalDetailsUrlAllowed(response.finalUrl, detailsUrl)) {
    return {
      status: "blocked",
      citation: citation.normalizedCitation,
      officialCaseName: null,
      detailsUrl,
      pdfUrl: null,
      payloadHash: null,
      observedAt,
      blocking: [response.status === 200 ? "official_redirect_invalid" : `official_http_${response.status}`],
    };
  }
  return { ...parseGovInfoUsReportsDetails(response.html, candidate), observedAt };
}
