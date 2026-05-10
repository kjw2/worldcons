import { load } from "cheerio";
import { addDiagnosticAttempt } from "@/lib/crawler/diagnostics";
import { crawlUrl } from "@/lib/crawler/http-client";
import { getRobotsSitemaps } from "@/lib/crawler/robots";
import type { CrawlerDiagnosticsCollector } from "@/lib/crawler/types";

export const SITEMAP_KEYWORDS = {
  "de-bverfg": ["shareddocs/entscheidungen/de/", "shareddocs/entscheidungen/en/"],
  "fr-conseil-constitutionnel": ["decision", "decisions", "qpc", "communique", "communiques", "actualite"],
  "us-scotus": ["opinions", "orders", "press"],
} satisfies Record<string, string[]>;

function unique(items: string[]) {
  return Array.from(new Set(items));
}

function locsFromXml(xml: string) {
  const $ = load(xml, { xmlMode: true });
  return $("loc")
    .map((_, loc) => $(loc).text().trim())
    .get()
    .filter(Boolean);
}

function matchesKeywords(url: string, keywords: string[]) {
  const lowered = decodeURIComponent(url).toLowerCase();
  return keywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
}

async function readSitemap(url: string, keywords: string[], depth: number, collector?: CrawlerDiagnosticsCollector): Promise<string[]> {
  if (depth > 2) return [];
  const response = await crawlUrl({ url });
  const locs = response.text ? locsFromXml(response.text) : [];
  addDiagnosticAttempt(collector, {
    url,
    finalUrl: response.finalUrl,
    strategy: "sitemap",
    status: response.status,
    contentType: response.contentType,
    discoveredCount: locs.length,
    timeout: response.diagnostics?.timeout,
    timeoutPhase: response.diagnostics?.timeoutPhase,
    errorCode: response.diagnostics?.errorCode,
    errorMessage: response.diagnostics?.errorMessage,
  });

  if (locs.some((loc) => loc.endsWith(".xml")) && depth < 2) {
    const nested = await Promise.all(locs.slice(0, 20).map((loc) => readSitemap(loc, keywords, depth + 1, collector)));
    return nested.flat();
  }

  return locs.filter((loc) => matchesKeywords(loc, keywords));
}

export async function discoverSitemapUrls(baseUrl: string, keywords: string[], collector?: CrawlerDiagnosticsCollector) {
  const origin = new URL(baseUrl).origin;
  const robotsSitemaps = await getRobotsSitemaps(origin).catch(() => []);
  const candidates = unique([...robotsSitemaps, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]);
  const maxUrls = Math.max(1, Number(process.env.SITEMAP_MAX_URLS ?? 200));
  const results: string[] = [];

  for (const candidate of candidates) {
    const urls = await readSitemap(candidate, keywords, 0, collector).catch(() => []);
    results.push(...urls);
    if (results.length >= maxUrls) break;
  }

  return unique(results).slice(0, maxUrls);
}
