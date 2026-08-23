export const DEFAULT_CRAWLER_USER_AGENT =
  "Mozilla/5.0 (compatible; ConstitutionalCourtCurationBot/0.1; +https://worldcons.vercel.app/)";

export function crawlerUserAgent() {
  return process.env.CRAWLER_USER_AGENT || process.env.INGEST_USER_AGENT || DEFAULT_CRAWLER_USER_AGENT;
}

export function crawlerHeaders(extra?: Record<string, string>) {
  return {
    "User-Agent": crawlerUserAgent(),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7",
    "Accept-Language": "en-US,en;q=0.8,de;q=0.7,fr;q=0.7,ko;q=0.6",
    "Cache-Control": "no-cache",
    ...extra,
  };
}
