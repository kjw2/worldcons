import { load } from "cheerio";
import { assertCrawlerExecution, checkpointCrawlerExecution } from "@/lib/crawler/cancellation";
import { addDiagnosticAttempt } from "@/lib/crawler/diagnostics";
import { crawlUrl } from "@/lib/crawler/http-client";
import { getRobotsSitemaps } from "@/lib/crawler/robots";
import type { CrawlerDiagnosticsCollector, CrawlerExecutionHooks } from "@/lib/crawler/types";

export const SITEMAP_KEYWORDS = {
  "de-bverfg": ["shareddocs/entscheidungen/de/", "shareddocs/entscheidungen/en/"],
  "es-tribunal-constitucional": ["resolucion/show", "resolucion/api/json", "hj/es/resolucion"],
  "fr-conseil-constitutionnel": ["decision", "decisions", "qpc", "communique", "communiques", "actualite"],
  "us-scotus": ["opinions", "orders", "press"],
} satisfies Record<string, string[]>;

function unique(items: string[]) {
  return Array.from(new Set(items));
}

async function locsFromXml(xml: string, hooks?: CrawlerExecutionHooks) {
  assertCrawlerExecution(hooks);
  const $ = load(xml, { xmlMode: true });
  await checkpointCrawlerExecution(hooks);
  const locs: string[] = [];
  const nodes = $("loc").toArray();
  for (let index = 0; index < nodes.length; index += 1) {
    if (index % 25 === 0) await checkpointCrawlerExecution(hooks);
    const loc = nodes[index];
    const value = $(loc).text().trim();
    if (value) locs.push(value);
  }
  return locs;
}

function matchesKeywords(url: string, keywords: string[]) {
  const lowered = decodeURIComponent(url).toLowerCase();
  return keywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
}

async function readSitemap(
  url: string,
  keywords: string[],
  depth: number,
  collector?: CrawlerDiagnosticsCollector,
  hooks?: CrawlerExecutionHooks,
): Promise<string[]> {
  await checkpointCrawlerExecution(hooks);
  if (depth > 2) return [];
  const response = await crawlUrl({
    url,
    signal: hooks?.signal,
    checkpoint: hooks?.checkpoint,
    requestGovernor: hooks?.requestGovernor,
  });
  await checkpointCrawlerExecution(hooks);
  const locs = response.text ? await locsFromXml(response.text, hooks) : [];
  const optionalIndex = /\/sitemap_index\.xml$/i.test(url);
  const optionalMissing = optionalIndex && response.status === 404;
  addDiagnosticAttempt(collector, {
    url,
    finalUrl: response.finalUrl,
    strategy: "sitemap",
    status: response.status,
    contentType: response.contentType,
    discoveredCount: locs.length,
    timeout: response.diagnostics?.timeout,
    timeoutPhase: response.diagnostics?.timeoutPhase,
    optional: optionalIndex,
    result: optionalMissing ? "empty" : undefined,
    errorCode: optionalMissing ? undefined : response.diagnostics?.errorCode,
    errorMessage: optionalMissing ? "Optional sitemap index is absent." : response.diagnostics?.errorMessage,
  });

  const nestedSitemaps: string[] = [];
  for (const loc of locs) {
    assertCrawlerExecution(hooks);
    if (loc.endsWith(".xml")) nestedSitemaps.push(loc);
  }
  if (nestedSitemaps.length > 0 && depth < 2) {
    const nested: string[] = [];
    for (const loc of nestedSitemaps.slice(0, 20)) {
      await checkpointCrawlerExecution(hooks);
      nested.push(...await readSitemap(loc, keywords, depth + 1, collector, hooks));
    }
    return nested;
  }

  const matches: string[] = [];
  for (const loc of locs) {
    assertCrawlerExecution(hooks);
    if (matchesKeywords(loc, keywords)) matches.push(loc);
  }
  await checkpointCrawlerExecution(hooks);
  return matches;
}

export async function discoverSitemapUrls(
  baseUrl: string,
  keywords: string[],
  collector?: CrawlerDiagnosticsCollector,
  hooks?: CrawlerExecutionHooks,
) {
  await checkpointCrawlerExecution(hooks);
  const origin = new URL(baseUrl).origin;
  let robotsSitemaps: string[] = [];
  try {
    robotsSitemaps = await getRobotsSitemaps(origin, hooks);
  } catch {
    if (hooks?.signal?.aborted) throw hooks.signal.reason;
    assertCrawlerExecution(hooks);
  }
  const candidates = unique([...robotsSitemaps, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]);
  const maxUrls = Math.max(1, Number(process.env.SITEMAP_MAX_URLS ?? 200));
  const results: string[] = [];

  for (const candidate of candidates) {
    await checkpointCrawlerExecution(hooks);
    let urls: string[] = [];
    try {
      urls = await readSitemap(candidate, keywords, 0, collector, hooks);
    } catch {
      if (hooks?.signal?.aborted) throw hooks.signal.reason;
      assertCrawlerExecution(hooks);
    }
    results.push(...urls);
    if (results.length >= maxUrls) break;
  }

  await checkpointCrawlerExecution(hooks);
  return unique(results).slice(0, maxUrls);
}
