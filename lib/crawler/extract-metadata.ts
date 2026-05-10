import { load } from "cheerio";

export interface HtmlMetadata {
  title?: string;
  description?: string;
  publishedAt?: string;
  decisionNumber?: string;
  caseNumber?: string;
  senateOrChamber?: string;
}

function clean(input?: string | null) {
  return input?.replace(/\s+/g, " ").trim() || undefined;
}

const LOCALIZED_MONTH_DATE =
  /\b\d{1,2}(?:er|\.)?\s+(?:janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre|januar|februar|marz|märz|april|juni|juli|august|september|oktober|dezember)\s+\d{4}\b/i;

export function extractHtmlMetadata(html?: string | null): HtmlMetadata {
  if (!html) return {};
  const $ = load(html);
  const text = $("body").text().replace(/\s+/g, " ");
  const ogTitle = clean($("meta[property='og:title']").attr("content"));
  const pageTitle = clean($("title").text());
  const visibleTitle =
    clean($("h1.title").first().text()) ||
    clean(
      $("h1")
        .filter((_, item) => !/search|visually-hidden|sr-only/i.test($(item).attr("class") ?? ""))
        .first()
        .text(),
    );
  const title = visibleTitle || ogTitle || pageTitle;
  const dateText = [title, ogTitle, pageTitle, text].filter(Boolean).join(" ");
  const description = clean($("meta[name='description']").attr("content")) || clean($("meta[property='og:description']").attr("content"));
  const publishedAt =
    clean($("time[datetime]").first().attr("datetime")) ||
    clean($("time").first().text()) ||
    clean(dateText.match(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/)?.[0]) ||
    clean(dateText.match(LOCALIZED_MONTH_DATE)?.[0]);
  const decisionNumber = clean(text.match(/\b(?:Décision|Decision)\s+n[°o]\s*[0-9]{4}-[0-9]+\s*(?:QPC|DC|AN|SEN)?\b/i)?.[0]);
  const caseNumber = clean(text.match(/\b(?:Az\.?|Case|Docket|Aktenzeichen)\s*[:：]?\s*[-A-Za-z0-9./ ]{3,40}\b/i)?.[0]);
  const senateOrChamber = clean(text.match(/\b(?:Erster|Zweiter)\s+Senat\b/i)?.[0] || text.match(/\b\d+\.\s+Kammer\b/i)?.[0]);

  return { title, description, publishedAt, decisionNumber, caseNumber, senateOrChamber };
}

export function titleFromUrl(url: string) {
  const pathname = new URL(url).pathname;
  const last = decodeURIComponent(pathname.split("/").filter(Boolean).pop() ?? pathname);
  return clean(last.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " "));
}
