import "dotenv/config";
import { countSelectorMatches, extractLinks } from "@/lib/crawler/extract-links";
import { extractHtmlMetadata } from "@/lib/crawler/extract-metadata";
import { crawlUrl } from "@/lib/crawler/http-client";
import { crawlWithPlaywright, isPlaywrightEnabled } from "@/lib/crawler/playwright-client";
import { checkRobotsAllowed } from "@/lib/crawler/robots";
import { discoverSitemapUrls, SITEMAP_KEYWORDS } from "@/lib/crawler/sitemap";

const SOURCE_DEFAULT_URLS: Record<string, string> = {
  "de-bverfg": "https://www.bundesverfassungsgericht.de/DE/Presse/Pressemitteilungen/pressemitteilungen_node.html",
  "fr-conseil-constitutionnel": "https://www.conseil-constitutionnel.fr/les-decisions",
  "us-scotus": "https://www.supremecourt.gov/opinions/slipopinion/25",
};

const SELECTORS_BY_SOURCE: Record<string, string[]> = {
  "de-bverfg": [
    "a[href*='Pressemitteilungen']",
    "a[href*='Entscheidungen']",
    "a[href*='SharedDocs']",
    "main a[href]",
    "article a[href]",
  ],
  "fr-conseil-constitutionnel": [
    "a[href*='/decision/']",
    "a[href*='decisions']",
    "a[href*='qpc']",
    "a[href*='communique']",
    "main a[href]",
    "article a[href]",
  ],
  "us-scotus": ["table.table a[href]", "a[href*='opinions']", "a[href*='orders']", "a[href*='press']", "main a[href]"],
};

function inferSource(url: string) {
  const hostname = new URL(url).hostname;
  if (hostname.includes("bundesverfassungsgericht")) return "de-bverfg";
  if (hostname.includes("conseil-constitutionnel")) return "fr-conseil-constitutionnel";
  if (hostname.includes("supremecourt")) return "us-scotus";
  return "unknown";
}

function recommendedNextAction(status: number, selectorMatches: number, sitemapCount: number) {
  if (status === 403 || status === 429) return "Use Playwright fallback and inspect blocked diagnostics; reduce request rate if repeated.";
  if (status === 0) return "Check network timeout, CRAWLER_TIMEOUT_MS, and whether Playwright fallback can render the URL.";
  if (status >= 400) return "Verify the official URL and inspect redirect/fetch diagnostics.";
  if (selectorMatches === 0 && sitemapCount > 0) return "Use sitemap fallback or add a more specific selector for the current template.";
  if (selectorMatches === 0) return "Inspect the rendered HTML and update selector candidates.";
  return "Fetch selectors are matching; proceed with adapter discovery/fetch.";
}

async function main() {
  const sourceKey = process.argv.find((arg) => arg.startsWith("--source="))?.split("=")[1];
  const urlArg = process.argv.find((arg) => arg.startsWith("--url="))?.slice("--url=".length);
  const url = urlArg ?? (sourceKey ? SOURCE_DEFAULT_URLS[sourceKey] : undefined);
  if (!url) throw new Error("Use --source=de-bverfg|fr-conseil-constitutionnel|us-scotus or --url=https://...");

  const source = sourceKey ?? inferSource(url);
  const selectors = SELECTORS_BY_SOURCE[source] ?? ["main a[href]", "article a[href]", "a[href]"];
  let response = await crawlUrl({ url });
  let strategy = response.strategy;
  if ((response.status === 403 || response.status === 0 || !response.html) && isPlaywrightEnabled()) {
    const fallback = await crawlWithPlaywright({ url, usePlaywright: true, waitUntil: "domcontentloaded" });
    if (fallback.html || fallback.status > 0) {
      response = fallback;
      strategy = "playwright";
    }
  }

  const html = response.html ?? response.text ?? "";
  const metadata = extractHtmlMetadata(html);
  const selectorCounts = html ? countSelectorMatches(html, selectors) : [];
  const links = html ? extractLinks(html, response.finalUrl, selectors).links : [];
  const robots = await checkRobotsAllowed(url).catch((error) => ({
    robotsUrl: new URL(url).origin + "/robots.txt",
    status: 0,
    allowed: true,
    sitemapUrls: [],
    errorMessage: error instanceof Error ? error.message : String(error),
  }));
  const sitemapUrls = await discoverSitemapUrls(new URL(url).origin, SITEMAP_KEYWORDS[source as keyof typeof SITEMAP_KEYWORDS] ?? [], undefined).catch(() => []);
  const selectorMatchTotal = selectorCounts.reduce((sum, item) => sum + item.count, 0);

  const report = {
    URL: url,
    strategy,
    status: response.status,
    "content-type": response.contentType ?? "-",
    "final URL": response.finalUrl,
    "HTML length": html.length,
    title: metadata.title ?? "-",
    "selector candidates": selectorCounts,
    "links discovered": links.length,
    "robots status": {
      robotsUrl: robots.robotsUrl,
      status: robots.status,
      allowed: robots.allowed,
      matchedRule: "matchedRule" in robots ? robots.matchedRule : undefined,
      sitemapUrls: robots.sitemapUrls,
      errorMessage: robots.errorMessage,
    },
    "sitemap availability": sitemapUrls.length,
    "recommended next action": recommendedNextAction(response.status, selectorMatchTotal, sitemapUrls.length),
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
