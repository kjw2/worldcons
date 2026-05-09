import { load } from "cheerio";

export interface ExtractedLink {
  url: string;
  title: string;
  surroundingText: string;
}

export interface SelectorCount {
  selector: string;
  count: number;
}

function clean(input?: string | null) {
  return input?.replace(/\s+/g, " ").trim() ?? "";
}

export function countSelectorMatches(html: string, selectors: string[]): SelectorCount[] {
  const $ = load(html);
  return selectors.map((selector) => ({
    selector,
    count: $(selector).length,
  }));
}

export function extractLinks(html: string, baseUrl: string, selectors: string[]) {
  const $ = load(html);
  const links: ExtractedLink[] = [];
  const selectorCounts = countSelectorMatches(html, selectors);
  const seen = new Set<string>();

  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const anchor = $(element).is("a") ? $(element) : $(element).find("a[href]").first();
      const href = anchor.attr("href");
      if (!href) return;

      const url = new URL(href, baseUrl).toString();
      if (seen.has(url)) return;
      seen.add(url);

      links.push({
        url,
        title: clean(anchor.text()) || clean(anchor.attr("title")) || clean(anchor.attr("aria-label")),
        surroundingText: clean(anchor.parent().text()),
      });
    });
  }

  return {
    links,
    selectorCounts,
    selectorMatched: selectorCounts.some((item) => item.count > 0),
    selectorMatchCount: selectorCounts.reduce((sum, item) => sum + item.count, 0),
  };
}

export function extractFeedLinks(xmlOrJsonText: string, baseUrl: string) {
  const trimmed = xmlOrJsonText.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const data = JSON.parse(trimmed) as unknown;
      const values = Array.isArray(data) ? data : Object.values((data ?? {}) as Record<string, unknown>);
      return values
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item): { url: string; title: string; publishedAt?: string } | null => {
          const rawUrl = String(item.url ?? item.link ?? item.href ?? "");
          if (!rawUrl) return null;
          return {
            url: new URL(rawUrl, baseUrl).toString(),
            title: clean(String(item.title ?? item.name ?? "")),
            publishedAt: clean(String(item.date ?? item.publishedAt ?? item.pubDate ?? "")) || undefined,
          };
        })
        .filter((item): item is { url: string; title: string; publishedAt?: string } => Boolean(item))
        .filter((item) => item.url !== baseUrl);
    } catch {
      return [];
    }
  }

  const $ = load(xmlOrJsonText, { xmlMode: true });
  const links: Array<{ url: string; title: string; publishedAt?: string }> = [];
  $("item, entry").each((_, item) => {
    const title = clean($(item).find("title").first().text());
    const href = clean($(item).find("link").first().text()) || clean($(item).find("link").first().attr("href"));
    const publishedAt = clean($(item).find("pubDate, published, updated, date").first().text());
    if (!href) return;
    links.push({ url: new URL(href, baseUrl).toString(), title, publishedAt });
  });

  return links;
}
