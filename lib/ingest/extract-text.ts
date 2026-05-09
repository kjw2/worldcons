import { Readability } from "@mozilla/readability";
import { load } from "cheerio";
import { JSDOM } from "jsdom";

export function cleanText(input?: string | null) {
  return (input ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractHtmlText(html: string, url: string) {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (article?.textContent && cleanText(article.textContent).length > 200) {
      return cleanText(article.textContent);
    }
  } catch {
    // Cheerio fallback below is deliberately broad for official pages with old templates.
  }

  const $ = load(html);
  const selected = [
    "main",
    "article",
    "#pagemaindiv",
    ".field--name-body",
    ".content",
    "body",
  ]
    .map((selector) => cleanText($(selector).text()))
    .find((text) => text.length > 200);

  return selected ?? cleanText($("body").text());
}

export async function extractPdfText(buffer: Buffer) {
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(buffer);
    return cleanText(parsed.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown PDF parsing error";
    throw new Error(`PDF text extraction failed: ${message}`);
  }
}
