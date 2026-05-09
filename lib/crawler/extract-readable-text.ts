import { Readability } from "@mozilla/readability";
import { load } from "cheerio";
import { JSDOM } from "jsdom";

export const DEFAULT_BODY_SELECTORS = ["main", "article", "#pagemaindiv", ".field--name-body", ".content", "#content", "body"];

export function cleanCrawlerText(input?: string | null) {
  return (input ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractReadableText(html: string, url: string, selectors = DEFAULT_BODY_SELECTORS) {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    const text = cleanCrawlerText(article?.textContent);
    if (text.length > 200) return text;
  } catch {
    // Selector fallback below is intentionally broad for official sites with older templates.
  }

  const $ = load(html);
  for (const selector of selectors) {
    const text = cleanCrawlerText($(selector).text());
    if (text.length > 200) return text;
  }

  return cleanCrawlerText($("body").text());
}
