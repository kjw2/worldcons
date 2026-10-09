import { readArticleLifecycleFromD1, transitionArticleLifecycleInD1 } from "../../../lib/cloudflare/core-write/authority";
import type { D1RuntimeDatabase } from "../../../lib/cloudflare/d1/runtime-binding";
import { shouldRetryBverfgCandidates, type BverfgTrackedCandidate } from "../../../lib/ingest/bverfg-candidate-retry";

export const NATIVE_CRAWLER_SOURCES = [
  "de-bverfg",
  "us-scotus",
  "fr-conseil-constitutionnel",
  "es-tribunal-constitucional",
] as const;

export type NativeCrawlerSource = (typeof NATIVE_CRAWLER_SOURCES)[number];

type NativeArticleCandidate = {
  sourceKey: NativeCrawlerSource;
  url: string;
  title: string;
  publishedAt?: string;
  contentType: "decision" | "opinion" | "order";
  metadata: Record<string, unknown>;
};

export type { NativeArticleCandidate };

type NativeCrawlerPreparedStatement = {
  bind(...values: unknown[]): NativeCrawlerPreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
};

type NativeCrawlerDatabase = {
  prepare(sql: string): NativeCrawlerPreparedStatement;
  batch(statements: NativeCrawlerPreparedStatement[]): Promise<unknown[]>;
};

type NativeCrawlerRawBucket = {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
};

export interface NativeCrawlerBindings {
  WORLDCONS_CORE: NativeCrawlerDatabase;
  WORLDCONS_INGEST: NativeCrawlerDatabase;
  WORLDCONS_RAW: NativeCrawlerRawBucket;
}

type CrawlerOptions = {
  fetch?: typeof fetch;
  now?: Date;
  limit?: number;
  rangeDays?: number;
  idempotencyKey?: string;
  browserNavigate?: (input: { url: string; timeoutMs: number; waitUntil: "domcontentloaded"; userAgent: string }) => Promise<{ html: string; finalUrl: string; status: number; headers: Record<string, string> }>;
};

const SOURCE_INFO: Record<NativeCrawlerSource, { name: string; jurisdiction: string; language: string; baseUrl: string; delayMs: number; rangeDays: number }> = {
  "de-bverfg": { name: "Federal Constitutional Court of Germany", jurisdiction: "Germany", language: "de", baseUrl: "https://www.bundesverfassungsgericht.de", delayMs: 3_000, rangeDays: 60 },
  "us-scotus": { name: "Supreme Court of the United States", jurisdiction: "United States", language: "en", baseUrl: "https://www.supremecourt.gov", delayMs: 2_000, rangeDays: 14 },
  "fr-conseil-constitutionnel": { name: "Conseil constitutionnel", jurisdiction: "France", language: "fr", baseUrl: "https://www.conseil-constitutionnel.fr", delayMs: 3_000, rangeDays: 14 },
  "es-tribunal-constitucional": { name: "Tribunal Constitucional de España", jurisdiction: "Spain", language: "es", baseUrl: "https://hj.tribunalconstitucional.es", delayMs: 2_000, rangeDays: 180 },
};

const BVERFG_OPENLEGALDATA_URL = "https://de.openlegaldata.io/api/cases/?court=3&format=json&o=-date";
/**
 * The finite number of most-recent official index candidates scanned per daily
 * run before D1-due/new selection. Large enough to skip a cooldown-window 404
 * head candidate, bounded so discovery never paginates or probes unboundedly.
 */
const BVERFG_INDEX_SCAN_WINDOW = 60;
const BVERFG_CANDIDATE_LOOKUP_CHUNK = 40;
const SPAIN_TAIL_PROBE_LIMIT = 30;
const SPAIN_TAIL_EMPTY_STOP = 3;
const SPAIN_SEARCH_TYPES = ["SENTENCIA", "AUTO", "DECLARACION"] as const;
const NATIVE_FETCH_TIMEOUT_MS = 60_000;

const SPANISH_MONTHS: Record<string, string> = { enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06", julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10", noviembre: "11", diciembre: "12" };
const FRENCH_MONTHS: Record<string, string> = { janvier: "01", février: "02", fevrier: "02", mars: "03", avril: "04", mai: "05", juin: "06", juillet: "07", août: "08", aout: "08", septembre: "09", octobre: "10", novembre: "11", décembre: "12", decembre: "12" };
const GERMAN_MONTHS: Record<string, string> = { januar: "01", februar: "02", märz: "03", marz: "03", april: "04", mai: "05", juni: "06", juli: "07", august: "08", september: "09", oktober: "10", november: "11", dezember: "12" };

function decodeHtml(value: string) {
  return value.replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function htmlText(value: string) {
  return decodeHtml(value.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6])>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[\t\r\f\v ]+/g, " ").replace(/\n\s+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function canonicalUrl(value: string, base: string) {
  const url = new URL(value, base);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|gclid$|fbclid$)/i.test(key)) url.searchParams.delete(key);
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

function dateIso(value?: string) {
  if (!value) return undefined;
  const trimmed = value.trim();
  const iso = trimmed.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}T00:00:00.000Z`;
  const dotted = trimmed.match(/\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/);
  if (dotted) return `${dotted[3]}-${dotted[2].padStart(2, "0")}-${dotted[1].padStart(2, "0")}T00:00:00.000Z`;
  const localized = trimmed.toLowerCase().normalize("NFC").match(/\b(\d{1,2})\s+([\p{L}]+)\s+(20\d{2})\b/u);
  if (localized) {
    const months = { ...FRENCH_MONTHS, ...GERMAN_MONTHS, ...SPANISH_MONTHS };
    const month = months[localized[2]];
    if (month) return `${localized[3]}-${month}-${localized[1].padStart(2, "0")}T00:00:00.000Z`;
  }
  const us = trimmed.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (us) return `${us[3].length === 2 ? `20${us[3]}` : us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}T00:00:00.000Z`;
  return undefined;
}

function spainDateIso(value?: string) {
  if (!value) return undefined;
  const slash = value.trim().match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (slash) return `${slash[3]}-${slash[2].padStart(2, "0")}-${slash[1].padStart(2, "0")}T00:00:00.000Z`;
  return dateIso(value);
}

function withinRange(value: string | undefined, rangeStart: number) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed >= rangeStart;
}

function absoluteLinks(html: string, baseUrl: string) {
  const result: Array<{ url: string; title: string; context: string }> = [];
  for (const match of html.matchAll(/<a\b([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = decodeHtml(match[3]);
    if (!href || /^(?:javascript:|mailto:|#)/i.test(href)) continue;
    try {
      const start = Math.max(0, (match.index ?? 0) - 600);
      const end = Math.min(html.length, (match.index ?? 0) + match[0].length + 600);
      result.push({ url: canonicalUrl(href, baseUrl), title: htmlText(match[5]), context: htmlText(html.slice(start, end)) });
    } catch { continue; }
  }
  return result;
}

function officialHost(source: NativeCrawlerSource, url: string) {
  const host = new URL(url).hostname.toLowerCase();
  const allowed: Record<NativeCrawlerSource, string[]> = {
    "de-bverfg": ["bundesverfassungsgericht.de", "bverfg.de"],
    "us-scotus": ["supremecourt.gov"],
    "fr-conseil-constitutionnel": ["conseil-constitutionnel.fr"],
    "es-tribunal-constitucional": ["hj.tribunalconstitucional.es"],
  };
  return allowed[source].some((root) => host === root || host.endsWith(`.${root}`));
}

async function boundedFetch(fetcher: typeof fetch, input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = NATIVE_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("crawler.fetch_timeout")), timeoutMs);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parseRobots(text: string, url: string) {
  const target = new URL(url).pathname + new URL(url).search;
  let matching = false;
  let specific = false;
  let delay = 0;
  const rules: Array<{ allow: boolean; pattern: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const index = line.indexOf(":");
    if (index < 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (key === "user-agent") {
      const agent = value.toLowerCase();
      matching = agent === "*" || "constitutionalcourtcurationbot".includes(agent);
      if (matching && agent !== "*") specific = true;
      continue;
    }
    if (!matching) continue;
    if (key === "crawl-delay") delay = Math.max(delay, Number(value) * 1000 || 0);
    if ((key === "allow" || key === "disallow") && value) rules.push({ allow: key === "allow", pattern: value });
  }
  const candidates = rules.filter((rule) => {
    const pattern = rule.pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\$$/, "$");
    return new RegExp(`^${pattern}`).test(target);
  }).sort((a, b) => b.pattern.replace(/[\*$]/g, "").length - a.pattern.replace(/[\*$]/g, "").length || Number(b.allow) - Number(a.allow));
  return { allowed: candidates[0]?.allow !== false, delayMs: delay };
}

async function getRobots(url: string, fetcher: typeof fetch) {
  const robotsUrl = `${new URL(url).origin}/robots.txt`;
  const response = await boundedFetch(fetcher, robotsUrl, { headers: { "user-agent": "ConstitutionalCourtCurationBot/0.1 (+https://worldcons.cclib.workers.dev/)" } });
  return response.ok ? response.text() : "";
}

async function waitForSourcePermit(source: NativeCrawlerSource, url: string, fetcher: typeof fetch, robotsCache: Map<string, string>, previousRequest: Map<string, number>) {
  const origin = new URL(url).origin;
  let robots = robotsCache.get(origin);
  if (robots === undefined) {
    robots = await getRobots(url, fetcher);
    robotsCache.set(origin, robots);
  }
  const policy = parseRobots(robots, url);
  if (!policy.allowed) throw new Error("crawler.robots_disallowed");
  const delay = Math.max(SOURCE_INFO[source].delayMs, policy.delayMs);
  const elapsed = Date.now() - (previousRequest.get(origin) ?? 0);
  if (elapsed < delay) await new Promise((resolve) => setTimeout(resolve, delay - elapsed));
  previousRequest.set(origin, Date.now());
}

async function fetchHtml(source: NativeCrawlerSource, url: string, bindings: NativeCrawlerBindings, fetcher: typeof fetch, robotsCache: Map<string, string>, previousRequest: Map<string, number>, allowBrowser: boolean, browserNavigate?: CrawlerOptions["browserNavigate"]) {
  if (!officialHost(source, url)) throw new Error("crawler.non_official_host");
  const origin = new URL(url).origin;
  let robots = robotsCache.get(origin);
  if (robots === undefined) {
    robots = await getRobots(url, fetcher);
    robotsCache.set(origin, robots);
  }
  const policy = parseRobots(robots, url);
  if (!policy.allowed) throw new Error("crawler.robots_disallowed");
  const delay = Math.max(SOURCE_INFO[source].delayMs, policy.delayMs);
  const elapsed = Date.now() - (previousRequest.get(origin) ?? 0);
  if (elapsed < delay) await new Promise((resolve) => setTimeout(resolve, delay - elapsed));
  previousRequest.set(origin, Date.now());
  const response = await boundedFetch(fetcher, url, { headers: { "user-agent": "ConstitutionalCourtCurationBot/0.1 (+https://worldcons.cclib.workers.dev/)", accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5" }, redirect: "follow" });
  const finalUrl = response.url || url;
  if (!officialHost(source, finalUrl)) throw new Error("crawler.redirect_non_official_host");
  if (response.ok) {
    const body = await response.text();
    if (body.length > 3_000_000) throw new Error("crawler.response_too_large");
    return { html: body, status: response.status, finalUrl, contentType: response.headers.get("content-type") ?? "" };
  }
  if (allowBrowser && [403, 429].includes(response.status)) {
    if (!browserNavigate) throw new Error("crawler.browser_navigation_unavailable");
    const rendered = await browserNavigate({ url, timeoutMs: 45_000, waitUntil: "domcontentloaded", userAgent: "ConstitutionalCourtCurationBot/0.1 (+https://worldcons.cclib.workers.dev/)" });
    if (new TextEncoder().encode(rendered.html).byteLength > 3_000_000) throw new Error("crawler.response_too_large");
    if (!officialHost(source, rendered.finalUrl)) throw new Error("crawler.redirect_non_official_host");
    return { html: rendered.html, status: rendered.status, finalUrl: rendered.finalUrl, contentType: rendered.headers["content-type"] ?? "text/html" };
  }
  throw new Error(`crawler.http_${response.status}`);
}

function bverfgDateContext(context: string, url: string) {
  const fromUrl = url.match(/\/(20\d{2})\/(\d{2})\/([a-z]{2})(20\d{2})(\d{2})(\d{2})_/i);
  const date = fromUrl ? `${fromUrl[4]}-${fromUrl[5]}-${fromUrl[6]}` : undefined;
  const docket = context.match(/\b[12]\s+Bv[A-Z]+\s+\d+\/\d{2,4}\b/)?.[0];
  return { date: date ? `${date}T00:00:00.000Z` : dateIso(context), docket };
}

function bverfgDecisionIdentity(url: string) {
  const pathname = new URL(url).pathname;
  const match = pathname.match(/^\/SharedDocs\/Entscheidungen\/DE\/(20\d{2})\/(\d{2})\/([a-z]{2})(20\d{2})(\d{2})(\d{2})_([a-z0-9]+)\.html$/i);
  if (!match || match[1] !== match[4] || match[2] !== match[5]) return null;
  return {
    ecli: `ECLI:DE:BVerfG:${match[1]}:${match[3].toLowerCase()}${match[4]}${match[5]}${match[6]}.${match[7].toLowerCase()}`,
    decisionId: `${match[4]}${match[5]}${match[6]}_${match[7]}`.toLowerCase(),
    publishedAt: `${match[4]}-${match[5]}-${match[6]}T00:00:00.000Z`,
  };
}

function verifyBverfgOfficialText(html: string, finalUrl: string, discoveredUrl: string) {
  const expected = bverfgDecisionIdentity(finalUrl);
  const discovered = bverfgDecisionIdentity(discoveredUrl);
  if (!expected || !discovered || expected.decisionId !== discovered.decisionId) {
    throw new Error("crawler.bverfg_official_identity_mismatch");
  }
  const text = extractOfficialText(html, "de-bverfg");
  const actual = text.match(/\bECLI:DE:BVerfG:20\d{2}:[a-z]{2}20\d{6}\.[a-z0-9]+\b/i)?.[0].toLowerCase();
  if (!actual || actual !== expected.ecli.toLowerCase()) throw new Error("crawler.bverfg_official_identity_mismatch");
  return { text, ecli: expected.ecli, publishedAt: expected.publishedAt };
}

function acceptBverfgOfficialVerification(candidate: NativeArticleCandidate, html: string, finalUrl: string, requestedUrl: string) {
  const verified = verifyBverfgOfficialText(html, finalUrl, requestedUrl);
  const priorEcli = candidate.metadata.ecli;
  if (typeof priorEcli === "string" && priorEcli.toLowerCase() !== verified.ecli.toLowerCase()) candidate.metadata.discoveryEcli = priorEcli;
  candidate.metadata.ecli = verified.ecli;
  candidate.metadata.officialIdentityVerification = "bverfg-ecli-exact-v1";
  candidate.url = finalUrl;
  candidate.publishedAt = verified.publishedAt;
  (candidate.metadata.collection as Record<string, unknown>).sourceUrlVerified = true;
  return verified.text;
}

function discoverBverfg(html: string, base: string, limit = BVERFG_INDEX_SCAN_WINDOW): NativeArticleCandidate[] {
  const links = absoluteLinks(html, base).filter((link) => officialHost("de-bverfg", link.url) && /\/SharedDocs\/Entscheidungen\/(?:DE|EN)\/20\d{2}\/\d{2}\/[a-z]{2}20\d{6}_[a-z0-9]+\.html/i.test(new URL(link.url).pathname));
  return links.slice(0, limit).map((link): NativeArticleCandidate => {
    const { date, docket } = bverfgDateContext(link.context, link.url);
    return { sourceKey: "de-bverfg", url: link.url, title: link.title || docket || link.url.split("/").at(-1) || "BVerfG decision", publishedAt: date, contentType: "decision", metadata: { caseNumber: docket, discoveryIndex: "official-listing", collection: { strategy: "official-listing", confidence: "high", sourceUrlVerified: true, sourceTextAvailable: false, publishable: false } } };
  });
}

function bverfgCandidateFromOpenLegalData(record: Record<string, unknown>): NativeArticleCandidate | null {
  const ecli = typeof record.ecli === "string" ? record.ecli.trim() : "";
  const match = ecli.match(/^ECLI:DE:BVerfG:(20\d{2}):([a-z]{2})(20\d{2})(\d{2})(\d{2})\.([a-z0-9]+)$/i);
  if (!match || match[1] !== match[3]) return null;
  const [, , prefix, year, month, day, casePart] = match;
  const primaryPrefix = prefix.toLowerCase();
  const variantPrefixes = primaryPrefix === "rk" || primaryPrefix === "rs"
    ? [primaryPrefix, primaryPrefix === "rk" ? "rs" : "rk"]
    : primaryPrefix === "qk" || primaryPrefix === "qs"
      ? [primaryPrefix, primaryPrefix === "qk" ? "qs" : "qk"]
      : [primaryPrefix];
  const officialUrlCandidates = variantPrefixes.map((candidatePrefix) => `${SOURCE_INFO["de-bverfg"].baseUrl}/SharedDocs/Entscheidungen/DE/${year}/${month}/${candidatePrefix}${year}${month}${day}_${casePart.toLowerCase()}.html`);
  const url = officialUrlCandidates[0];
  const publishedAt = dateIso(typeof record.date === "string" ? record.date : `${year}-${month}-${day}`);
  const caseNumber = typeof record.file_number === "string" ? record.file_number.trim() : undefined;
  const decisionType = typeof record.type === "string" ? record.type.trim() : undefined;
  return {
    sourceKey: "de-bverfg",
    url,
    title: [decisionType, caseNumber, publishedAt?.slice(0, 10)].filter(Boolean).join(" - ") || caseNumber || "BVerfG decision",
    publishedAt,
    contentType: "decision",
    metadata: {
      caseNumber,
      ecli,
      officialUrlCandidates,
      officialUrlResolverVersion: 2,
      discoveryIndex: "openlegaldata",
      discoveryIndexUrl: BVERFG_OPENLEGALDATA_URL,
      collection: {
        strategy: "api",
        confidence: "medium",
        sourceUrlVerified: false,
        sourceTextAvailable: false,
        publishable: false,
        reason: "Candidate discovered through OpenLegalData; publication requires successful fetch from the official BVerfG URL.",
      },
    },
  };
}

async function discoverBverfgOpenLegalData(fetcher: typeof fetch, rangeStart: number, limit: number) {
  const candidates: NativeArticleCandidate[] = [];
  let next: string | null = BVERFG_OPENLEGALDATA_URL;
  for (let page = 0; page < 4 && next && candidates.length < limit; page += 1) {
    const response = await boundedFetch(fetcher, next, {
      headers: { accept: "application/json", "user-agent": "ConstitutionalCourtCurationBot/0.1 (+https://worldcons.cclib.workers.dev/)" },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`crawler.bverfg_index_http_${response.status}`);
    const payload = await response.json() as { next?: unknown; results?: unknown };
    const rows = Array.isArray(payload.results) ? payload.results : [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const candidate = bverfgCandidateFromOpenLegalData(row as Record<string, unknown>);
      if (!candidate || !withinRange(candidate.publishedAt, rangeStart)) continue;
      candidates.push(candidate);
      if (candidates.length >= limit) break;
    }
    next = typeof payload.next === "string" && payload.next.startsWith("https://de.openlegaldata.io/") ? payload.next : null;
  }
  return candidates;
}

function isTransientCrawlerHttpError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /^crawler\.http_5\d\d$/u.test(error.message)
    || /^crawler\.bverfg_index_http_5\d\d$/u.test(error.message);
}

/** Every canonical URL a discovery candidate could be tracked under. */
function bverfgCandidateLookupUrls(candidate: NativeArticleCandidate) {
  const configured = Array.isArray(candidate.metadata.officialUrlCandidates)
    ? candidate.metadata.officialUrlCandidates.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const urls: string[] = [];
  for (const value of [candidate.url, ...configured]) {
    try {
      urls.push(canonicalUrl(value, value));
    } catch {
      continue;
    }
  }
  return [...new Set(urls)];
}

/**
 * Loads the durable D1 `source_url_candidates` state for a bounded set of
 * candidate URLs. An unreadable store must fail closed: treating unknown
 * candidates as fresh could bypass a durable retry cooldown and send extra
 * requests to the official court. Reads are chunked and bounded.
 */
async function loadBverfgTrackedCandidates(db: NativeCrawlerDatabase, urls: string[]) {
  const unique = [...new Set(urls.filter(Boolean))];
  if (unique.length === 0) return new Map<string, BverfgTrackedCandidate>();
  const tracked = new Map<string, BverfgTrackedCandidate>();
  for (let index = 0; index < unique.length; index += BVERFG_CANDIDATE_LOOKUP_CHUNK) {
    const chunk = unique.slice(index, index + BVERFG_CANDIDATE_LOOKUP_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    try {
      const result = await db.prepare(`SELECT url, status, attempt_count, last_attempt_at, last_error_code FROM source_url_candidates WHERE source_key = ? AND url IN (${placeholders})`).bind("de-bverfg", ...chunk).all<{ url: string; status: string; attempt_count: number | string | null; last_attempt_at: string | null; last_error_code: string | null }>();
      for (const row of result?.results ?? []) {
        if (!row || typeof row.url !== "string") continue;
        tracked.set(row.url, {
          url: row.url,
          status: String(row.status ?? ""),
          attemptCount: Number(row.attempt_count ?? 0),
          lastAttemptAt: row.last_attempt_at,
          lastErrorCode: row.last_error_code,
        });
      }
    } catch {
      throw new Error("crawler.bverfg_candidate_state_unavailable");
    }
  }
  return tracked;
}

export interface BverfgDiscoverySelection {
  selected: NativeArticleCandidate[];
  deferred: number;
  alreadyFetched: number;
}

/**
 * Deterministic bounded selection of BVerfG discovery candidates that respects
 * the established D1 candidate retry/backoff semantics:
 *
 * - a candidate with a `retrying` D1 record inside its backoff window is
 *   deferred (never fetched again early);
 * - a candidate with a `retrying` record past its delay is due and is selected
 *   before new candidates;
 * - new / untracked candidates follow;
 * - candidates whose URL is already `fetched` are selected last so they can
 *   never starve new or due candidates.
 *
 * Selection preserves discovery order inside each bucket, is capped at `limit`,
 * and never performs network or D1 work itself.
 */
export function selectBverfgDiscoveryCandidates(
  candidates: NativeArticleCandidate[],
  tracked: Map<string, BverfgTrackedCandidate>,
  limit: number,
  now: Date,
): BverfgDiscoverySelection {
  const due: NativeArticleCandidate[] = [];
  const fresh: NativeArticleCandidate[] = [];
  const fetched: NativeArticleCandidate[] = [];
  let deferred = 0;
  for (const candidate of candidates) {
    const records = bverfgCandidateLookupUrls(candidate)
      .map((url) => tracked.get(url))
      .filter((record): record is BverfgTrackedCandidate => Boolean(record));
    const retrying = records.filter((record) => record.status === "retrying");
    if (retrying.length > 0) {
      if (shouldRetryBverfgCandidates(records, now)) due.push(candidate);
      else deferred += 1;
      continue;
    }
    if (records.some((record) => record.status === "fetched")) fetched.push(candidate);
    else fresh.push(candidate);
  }
  const boundedLimit = Math.max(0, Math.trunc(limit));
  return {
    selected: [...due, ...fresh, ...fetched].slice(0, boundedLimit),
    deferred,
    alreadyFetched: fetched.length,
  };
}

function discoverFrance(html: string, base: string): NativeArticleCandidate[] {
  return absoluteLinks(html, base).filter((link) => officialHost("fr-conseil-constitutionnel", link.url) && (/^\/decision\/20\d{2}\/[^/]+\.html?$/i.test(new URL(link.url).pathname) || /^\/20\d{2}-\d{2}-\d{2}\/decision-/i.test(new URL(link.url).pathname))).map((link) => ({
    sourceKey: "fr-conseil-constitutionnel", url: link.url, title: link.title || link.url.split("/").at(-1) || "Décision", publishedAt: dateIso(`${link.context} ${link.url}`), contentType: "decision", metadata: { decisionNumber: link.context.match(/\bn[°ºo]?\s*[0-9]{4}-[0-9]+\s*(?:QPC|DC|L|AN|SEN)?/i)?.[0], collection: { strategy: "official-listing", confidence: "high", sourceUrlVerified: true, sourceTextAvailable: false, publishable: false } },
  }));
}

function discoverScotus(html: string, listingUrl: string): NativeArticleCandidate[] {
  const candidates: NativeArticleCandidate[] = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    if (cells.length < 4) continue;
    const anchor = cells[3].match(/<a\b([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/i);
    if (!anchor || !/\.pdf(?:$|[?#])/i.test(anchor[3])) continue;
    const href = canonicalUrl(anchor[3], "https://www.supremecourt.gov");
    candidates.push({ sourceKey: "us-scotus", url: href, title: htmlText(anchor[5]) || href.split("/").at(-1) || "SCOTUS opinion", publishedAt: dateIso(htmlText(cells[1])), contentType: "opinion", metadata: { docket: htmlText(cells[2]), revisionDate: htmlText(row[1]).match(/Revisions?:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] ? dateIso(htmlText(row[1]).match(/Revisions?:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1]) : undefined, listingUrl, officialPdfUrlDiscovered: true, collection: { strategy: "official-listing", confidence: "medium", sourceUrlVerified: true, sourceTextAvailable: false, publishable: false, reason: "Official SCOTUS PDF metadata is preserved; no Worker-safe PDF text extraction is configured, so human review is required." }, review: { required: true, reason: "pdf_text_extraction_unavailable" } } });
  }
  return candidates;
}

function discoverSpain(html: string, base: string): NativeArticleCandidate[] {
  return absoluteLinks(html, base).filter((link) => {
    if (!officialHost("es-tribunal-constitucional", link.url)) return false;
    const id = new URL(link.url).pathname.match(/\/Resolucion\/Show\/(\d+)\/?$/i)?.[1];
    return id !== undefined && Number.isSafeInteger(Number(id)) && Number(id) > 0;
  }).map((link) => ({
    sourceKey: "es-tribunal-constitucional", url: link.url, title: link.title || `Resolución HJ ${link.url.match(/Show\/(\d+)/i)?.[1]}`, publishedAt: dateIso(link.context), contentType: /\bAUTO\b/i.test(link.title) ? "order" : "decision", metadata: { hjId: link.url.match(/Show\/(\d+)/i)?.[1], collection: { strategy: "official-listing", confidence: "medium", sourceUrlVerified: true, sourceTextAvailable: false, strictSourceTextAvailable: true, publishable: false } },
  }));
}

function headerSetCookies(headers: Headers) {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const values = extended.getSetCookie?.();
  if (values?.length) return values;
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function mergeCookies(cookies: Map<string, string>, values: string[]) {
  for (const value of values) {
    const first = value.split(";")[0];
    const index = first.indexOf("=");
    if (index > 0) cookies.set(first.slice(0, index), first.slice(index + 1));
  }
}

function cookieHeader(cookies: Map<string, string>) {
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function ddMmYyyy(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

async function discoverSpainSearch(fetcher: typeof fetch, robotsCache: Map<string, string>, lastRequest: Map<string, number>, rangeStart: number, limit: number) {
  const base = SOURCE_INFO["es-tribunal-constitucional"].baseUrl;
  const indexPaths = ["/HJ/es/Busqueda/Index", "/es/Busqueda/Index"];
  let session: { indexUrl: string; ajaxUrls: string[]; listUrls: string[]; token: string; cookies: Map<string, string> } | null = null;
  for (const path of indexPaths) {
    const indexUrl = `${base}${path}`;
    try {
      await waitForSourcePermit("es-tribunal-constitucional", indexUrl, fetcher, robotsCache, lastRequest);
      const response = await boundedFetch(fetcher, indexUrl, { headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": "es,en;q=0.8,ko;q=0.5", "user-agent": "ConstitutionalCourtCurationBot/0.1 (+https://worldcons.cclib.workers.dev/)" }, redirect: "follow" });
      if (!response.ok) continue;
      const cookies = new Map<string, string>();
      mergeCookies(cookies, headerSetCookies(response.headers));
      const html = await response.text();
      const token = html.match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)/i)?.[1]
        ?? html.match(/value=["']([^"']+)["'][^>]*name=["']__RequestVerificationToken/i)?.[1];
      if (!token) continue;
      const prefix = path.startsWith("/HJ/") ? "/HJ" : "";
      session = {
        indexUrl,
        ajaxUrls: [`${base}${prefix}/es/Busqueda/BuscarAjax`, `${base}/HJ/es/Busqueda/BuscarAjax`, `${base}/es/Busqueda/BuscarAjax`],
        listUrls: [`${base}${prefix}/es/Resolucion/List`, `${base}/HJ/es/Resolucion/List`, `${base}/es/Resolucion/List`],
        token,
        cookies,
      };
      break;
    } catch {
      continue;
    }
  }
  if (!session) return [];

  const from = new Date(rangeStart).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const fromYear = Number(from.slice(0, 4));
  const toYear = Number(to.slice(0, 4));
  const candidates = new Map<string, NativeArticleCandidate>();

  for (const type of SPAIN_SEARCH_TYPES) {
    for (let year = toYear; year >= fromYear && candidates.size < limit; year -= 1) {
      const body = new URLSearchParams({ __RequestVerificationToken: session.token, TIPO_RESOLUCION: type, NUMERO_RESOLUCION: "", ANNO_RESOLUCION: String(year), BIS_RESOLUCION: "", FECHA_DESDE: ddMmYyyy(from), FECHA_HASTA: ddMmYyyy(to), BUSQUEDA_LIBRE: "" });
      let hasResults = false;
      for (const ajaxUrl of [...new Set(session.ajaxUrls)]) {
        try {
          await waitForSourcePermit("es-tribunal-constitucional", ajaxUrl, fetcher, robotsCache, lastRequest);
          const response = await boundedFetch(fetcher, ajaxUrl, { method: "POST", headers: { accept: "application/json,text/plain,*/*", "accept-language": "es,en;q=0.8,ko;q=0.5", "content-type": "application/x-www-form-urlencoded; charset=UTF-8", cookie: cookieHeader(session.cookies), origin: base, referer: session.indexUrl, "x-requested-with": "XMLHttpRequest", "user-agent": "ConstitutionalCourtCurationBot/0.1 (+https://worldcons.cclib.workers.dev/)" }, body, redirect: "follow" });
          mergeCookies(session.cookies, headerSetCookies(response.headers));
          const text = await response.text();
          if (response.ok && /"success"\s*:\s*"1"/.test(text)) { hasResults = true; break; }
          if (response.ok && /"success"\s*:\s*"0"/.test(text) && /No se han encontrado resultados/i.test(text)) break;
        } catch {
          continue;
        }
      }
      if (!hasResults) continue;

      for (let page = 1; page <= 4 && candidates.size < limit; page += 1) {
        let pageItems: NativeArticleCandidate[] | null = null;
        for (const listUrl of [...new Set(session.listUrls)]) {
          try {
            const url = `${listUrl}?page=${page}`;
            await waitForSourcePermit("es-tribunal-constitucional", url, fetcher, robotsCache, lastRequest);
            const response = await boundedFetch(fetcher, url, { headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": "es,en;q=0.8,ko;q=0.5", cookie: cookieHeader(session.cookies), referer: session.indexUrl, "x-requested-with": "XMLHttpRequest", "user-agent": "ConstitutionalCourtCurationBot/0.1 (+https://worldcons.cclib.workers.dev/)" }, redirect: "follow" });
            mergeCookies(session.cookies, headerSetCookies(response.headers));
            if (!response.ok) continue;
            const html = await response.text();
            pageItems = discoverSpain(html, base).map((candidate) => ({ ...candidate, metadata: { ...candidate.metadata, discoveryIndex: "official-search", resolutionType: type, collection: { ...(candidate.metadata.collection as Record<string, unknown>), strategy: "api", confidence: "high", sourceUrlVerified: true } } }));
            break;
          } catch {
            continue;
          }
        }
        if (!pageItems?.length) break;
        for (const candidate of pageItems) {
          // BuscarAjax is already scoped by FECHA_DESDE/FECHA_HASTA. List labels do not
          // consistently expose a parseable decision date, so do not discard an official
          // search hit merely because the list title lacks one. fetchCandidate() will
          // refresh publishedAt from FECHA_REGISTRO when the JSON detail endpoint responds.
          candidates.set(candidate.url, candidate);
          if (candidates.size >= limit) break;
        }
      }
    }
  }
  return [...candidates.values()].slice(0, limit);
}

function spainPayloadCandidate(payload: Record<string, unknown>, hjId: number): NativeArticleCandidate | null {
  const resolutionType = typeof payload.TIPO_RESOLUCION === "string" ? payload.TIPO_RESOLUCION.trim().toUpperCase() : "";
  if (!new Set(["SENTENCIA", "AUTO", "DECLARACION", "DECLARACIÓN"]).has(resolutionType)) return null;
  const publishedAt = spainDateIso(typeof payload.FECHA_REGISTRO === "string" ? payload.FECHA_REGISTRO : undefined);
  const number = payload.NUMERO_RESOLUCION === undefined || payload.NUMERO_RESOLUCION === null ? "" : String(payload.NUMERO_RESOLUCION);
  const year = payload.ANNO_RESOLUCION === undefined || payload.ANNO_RESOLUCION === null ? "" : String(payload.ANNO_RESOLUCION);
  const title = `${resolutionType}${number ? ` ${number}${year ? `/${year}` : ""}` : ""}${publishedAt ? `, ${publishedAt.slice(0, 10)}` : ""}`;
  const irrelevant = payload.CONTENIDO_IRRELEVANTE_PARA_INTERNET === true
    || /no incorpora doctrina constitucional|no contiene doctrina constitucional/i.test(String(payload.AVISO ?? ""));
  return {
    sourceKey: "es-tribunal-constitucional",
    url: `${SOURCE_INFO["es-tribunal-constitucional"].baseUrl}/HJ/es/Resolucion/Show/${hjId}`,
    title,
    publishedAt,
    contentType: resolutionType === "AUTO" ? "order" : "decision",
    metadata: {
      hjId: String(hjId),
      resolutionType,
      notice: typeof payload.AVISO === "string" ? payload.AVISO : undefined,
      ...(irrelevant ? { review: { required: true, reason: "official_metadata_requires_review" } } : {}),
      collection: {
        strategy: "api",
        confidence: "high",
        sourceUrlVerified: true,
        sourceTextAvailable: false,
        strictSourceTextAvailable: true,
        publishable: false,
      },
    },
  };
}

function spainPayloadText(payload: Record<string, unknown>) {
  const sections = ["RESOLUCIONES_ANTECEDENTES", "RESOLUCIONES_FUNDAMENTOS", "RESOLUCIONES_DICTAMEN", "RESOLUCIONES_VOTOS_PARTICULARES"];
  return sections.flatMap((key) => Array.isArray(payload[key])
    ? (payload[key] as Array<Record<string, unknown>>).map((entry) => htmlText(String(entry.TEXTO ?? "")))
    : []).filter(Boolean).join("\n\n");
}

async function fetchSpainJson(fetcher: typeof fetch, bindings: NativeCrawlerBindings, robotsCache: Map<string, string>, lastRequest: Map<string, number>, hjId: number, browserNavigate?: CrawlerOptions["browserNavigate"]) {
  const apis = [
    `${SOURCE_INFO["es-tribunal-constitucional"].baseUrl}/HJ/Resolucion/Api/json/${hjId}`,
    `${SOURCE_INFO["es-tribunal-constitucional"].baseUrl}/Resolucion/Api/json/${hjId}`,
  ];
  for (const api of apis) {
    await waitForSourcePermit("es-tribunal-constitucional", api, fetcher, robotsCache, lastRequest);
    let response: Response | null = null;
    try {
      response = await boundedFetch(fetcher, api, { headers: { accept: "application/json,text/plain;q=0.8,*/*;q=0.5", "accept-language": "es,en;q=0.8,ko;q=0.5", "user-agent": "ConstitutionalCourtCurationBot/0.1 (+https://worldcons.cclib.workers.dev/)" }, redirect: "follow" });
    } catch {
      response = null;
    }
    if (response) {
      if (!officialHost("es-tribunal-constitucional", response.url || api)) throw new Error("crawler.redirect_non_official_host");
      if (response.ok) {
        const body = await response.text().catch(() => "");
        if (body.trim()) {
          const payload = JSON.parse(body) as unknown;
          if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, unknown>;
        }
      }
    }
    if (!browserNavigate) continue;
    try {
      const rendered = await browserNavigate({ url: api, timeoutMs: 45_000, waitUntil: "domcontentloaded", userAgent: "ConstitutionalCourtCurationBot/0.1 (+https://worldcons.cclib.workers.dev/)" });
      if (!officialHost("es-tribunal-constitucional", rendered.finalUrl || api)) throw new Error("crawler.redirect_non_official_host");
      const body = htmlText(rendered.html);
      const start = body.indexOf("{");
      const end = body.lastIndexOf("}");
      if (start < 0 || end <= start) continue;
      const payload = JSON.parse(body.slice(start, end + 1)) as unknown;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, unknown>;
    } catch {
      // Fall through to the alternate official API path.
    }
  }
  return null;
}

async function discoverSpainTail(bindings: NativeCrawlerBindings, fetcher: typeof fetch, robotsCache: Map<string, string>, lastRequest: Map<string, number>, rangeStart: number, limit: number, browserNavigate?: CrawlerOptions["browserNavigate"]) {
  const row = await bindings.WORLDCONS_CORE.prepare("SELECT MAX(CAST(json_extract(source_metadata,'$.hjId') AS INTEGER)) AS max_hj_id FROM articles WHERE source_key='es-tribunal-constitucional'").first<{ max_hj_id: number | string | null }>();
  const maxId = Number(row?.max_hj_id ?? 0);
  if (!Number.isFinite(maxId) || maxId <= 0) return [];
  const candidates: NativeArticleCandidate[] = [];
  let empty = 0;
  for (let offset = 1; offset <= SPAIN_TAIL_PROBE_LIMIT && candidates.length < limit && empty < SPAIN_TAIL_EMPTY_STOP; offset += 1) {
    const hjId = Math.trunc(maxId) + offset;
    const payload = await fetchSpainJson(fetcher, bindings, robotsCache, lastRequest, hjId, browserNavigate).catch(() => null);
    const candidate = payload ? spainPayloadCandidate(payload, hjId) : null;
    if (!candidate) {
      empty += 1;
      continue;
    }
    empty = 0;
    if (withinRange(candidate.publishedAt, rangeStart)) candidates.push(candidate);
  }
  return candidates;
}

function extractOfficialText(html: string, source: NativeCrawlerSource) {
  const selectors: Record<NativeCrawlerSource, RegExp[]> = {
    "de-bverfg": [/<main\b[^>]*>([\s\S]*?)<\/main>/i, /<article\b[^>]*>([\s\S]*?)<\/article>/i, /<body\b[^>]*>([\s\S]*?)<\/body>/i],
    "us-scotus": [],
    "fr-conseil-constitutionnel": [/<main\b[^>]*>([\s\S]*?)<\/main>/i, /<article\b[^>]*>([\s\S]*?)<\/article>/i, /<body\b[^>]*>([\s\S]*?)<\/body>/i],
    "es-tribunal-constitucional": [/<main\b[^>]*>([\s\S]*?)<\/main>/i, /<body\b[^>]*>([\s\S]*?)<\/body>/i],
  };
  for (const selector of selectors[source]) {
    const body = html.match(selector)?.[1];
    if (body) return htmlText(body);
  }
  return "";
}

function cleanText(text: string) {
  return text.replace(/[\u00a0\t ]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function sha256(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer as ArrayBuffer));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function slugify(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "article";
}

function articleStatus(candidate: NativeArticleCandidate, text: string) {
  const collection = candidate.metadata.collection as Record<string, unknown>;
  const sufficientText = text.length >= (candidate.sourceKey === "es-tribunal-constitucional" ? 2_000 : 500);
  const sourceTextAvailable = collection.strictSourceTextAvailable === true
    ? collection.sourceTextAvailable === true && sufficientText
    : sufficientText;
  if (candidate.sourceKey === "us-scotus" || (candidate.metadata.review as Record<string, unknown> | undefined)?.required === true) return "needs_review";
  if (!sourceTextAvailable) return candidate.sourceKey === "es-tribunal-constitucional" ? "needs_review" : "metadata_only";
  collection.sourceTextAvailable = true;
  collection.publishable = true;
  collection.confidence = "high";
  collection.strategy = "fetch";
  return "cleaned";
}

async function upsertCandidate(db: NativeCrawlerDatabase, source: NativeCrawlerSource, url: string, code: string | null, message: string | null, success: boolean) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO source_url_candidates (id, source_key, url, candidate_type, discovered_by, status, last_attempt_at, attempt_count, last_error_code, last_error_message, created_at, updated_at)
    VALUES (?, ?, ?, 'decision', 'crawler-daily', ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(source_key, url) DO UPDATE SET status=excluded.status, last_attempt_at=excluded.last_attempt_at, attempt_count=source_url_candidates.attempt_count+1, last_error_code=excluded.last_error_code, last_error_message=excluded.last_error_message, updated_at=excluded.updated_at`)
    .bind(crypto.randomUUID(), source, url, success ? "fetched" : "retrying", now, code, message?.slice(0, 500) ?? null, now, now).run();
}

export type NativePersistOutcome = "duplicate" | "preserved" | "unchanged" | "refreshed" | "inserted";

export interface NativePersistResult {
  outcome: NativePersistOutcome;
  articleId: string | null;
  canonicalUrl: string;
  contentHash: string;
  status: string;
}

async function persistArticle(bindings: NativeCrawlerBindings, candidate: NativeArticleCandidate, text: string, runId: string, fetchedAt: string): Promise<NativePersistResult> {
  const core = bindings.WORLDCONS_CORE;
  const canonical = canonicalUrl(candidate.url, candidate.url);
  const clean = cleanText(text);
  const status = articleStatus(candidate, clean);
  const contentHash = await sha256(clean.replace(/\s+/g, " ").trim() || `${candidate.sourceKey}:${canonical}`);
  const existing = await core.prepare("SELECT id, content_hash, status, cleaned_text, source_metadata, slug, review_state FROM articles WHERE canonical_url = ? LIMIT 1").bind(canonical).first<Record<string, unknown>>();
  const lifecycleBefore = existing ? await readArticleLifecycleFromD1(core as unknown as D1RuntimeDatabase, String(existing.id)) : null;
  if (lifecycleBefore && !lifecycleBefore.ok) throw new Error("crawler.lifecycle_read_failed");
  const duplicate = existing ? null : await core.prepare("SELECT id FROM articles WHERE content_hash = ? LIMIT 1").bind(contentHash).first<{ id: string }>();
  if (duplicate) return { outcome: "duplicate", articleId: duplicate.id, canonicalUrl: canonical, contentHash, status };
  const oldMetadata = (() => { try { return JSON.parse(String(existing?.source_metadata ?? "{}")) as Record<string, unknown>; } catch { return {}; } })();
  const metadata = { ...oldMetadata, ...candidate.metadata, collection: { ...(oldMetadata.collection as Record<string, unknown> ?? {}), ...(candidate.metadata.collection as Record<string, unknown>), diagnosticsId: runId, source: SOURCE_INFO[candidate.sourceKey].baseUrl }, ingestion: { runId, crawler: "worldcons-ingest-native-v1", fetchedAt } };
  const data = JSON.stringify(metadata);
  const oldTextLength = String(existing?.cleaned_text ?? "").trim().length;
  const publicWasPublishable = existing?.status === "summarized" && (oldMetadata.collection as Record<string, unknown> | undefined)?.publishable === true;
  const regression = Boolean(existing && publicWasPublishable && (status !== "cleaned" || clean.length < Math.max(500, Math.floor(oldTextLength * 0.6))));
  if (regression) return { outcome: "preserved", articleId: String(existing?.id ?? ""), canonicalUrl: canonical, contentHash, status };
  if (existing && existing.content_hash === contentHash) {
    await core.prepare("UPDATE articles SET original_url=?, original_title=?, original_published_at=?, fetched_at=?, source_metadata=?, updated_at=? WHERE id=?")
      .bind(candidate.url, candidate.title, candidate.publishedAt ?? null, fetchedAt, data, fetchedAt, existing.id).run();
    return { outcome: "unchanged", articleId: String(existing.id), canonicalUrl: canonical, contentHash, status };
  }
  const rawBytes = new TextEncoder().encode(JSON.stringify(text));
  const rawHash = await sha256(rawBytes);
  const rawRef = `artifacts/article_raw/${candidate.sourceKey}/${rawHash}.json`;
  await bindings.WORLDCONS_RAW.put(rawRef, rawBytes, { httpMetadata: { contentType: "application/json" } });
  const titleSlug = slugify(candidate.title);
  const datePart = candidate.publishedAt ? candidate.publishedAt.slice(0, 10) : "undated";
  const slug = existing?.slug ? String(existing.slug) : `${slugify(SOURCE_INFO[candidate.sourceKey].jurisdiction)}-${slugify(candidate.sourceKey)}-${datePart}-${titleSlug}-${(await sha256(canonical)).slice(0, 6)}`;
  const legacyStatus = status === "needs_review" ? "metadata_only" : status;
  const translationStatus = status === "cleaned" && SOURCE_INFO[candidate.sourceKey].language.toLowerCase() !== "ko"
    ? "pending"
    : "not_required";
  if (existing) {
    if (!lifecycleBefore?.ok) throw new Error("crawler.lifecycle_read_failed");
    const before = lifecycleBefore.data;
    const collectionState = status === "cleaned" ? "source_text_ready" : "metadata_only";
    const processingState = status === "cleaned" ? "ready" : "not_ready";
    if (status !== "cleaned" && before.processingState === "complete") return { outcome: "preserved", articleId: String(existing.id), canonicalUrl: canonical, contentHash, status };
    const lifecycleChanged = before.collectionState !== collectionState
      || before.processingState !== processingState
      || (status === "needs_review" && before.reviewState !== "closed_private" && before.reviewState !== "needs_review")
      || (status === "cleaned" && before.attentionState === "active" && before.attentionCode === "collection.metadata_only")
      || (status === "metadata_only" && (before.attentionState !== "active" || before.attentionCode !== "collection.metadata_only"));
    if (lifecycleChanged) {
      const after = await transitionArticleLifecycleInD1(core as unknown as D1RuntimeDatabase, {
        articleId: String(existing.id),
        expectedRevision: before.revision,
        idempotencyKey: `native-crawler:${runId}:${contentHash}`,
        actorType: "ingestion",
        actorId: "worldcons-ingest-native-v1",
        source: "ingestion.refresh",
        reasonCode: "source_content_refreshed",
        collectionState,
        processingState,
        ...(status === "needs_review" && before.reviewState !== "closed_private" ? { reviewState: "needs_review" as const } : before.reviewState === null ? { reviewState: "unreviewed" as const } : {}),
        ...(status === "cleaned" && before.attentionState === "active" && before.attentionCode === "collection.metadata_only" ? { attention: { operation: "clear" as const, resolvesCodes: ["collection.metadata_only"] } } : {}),
        ...(status === "metadata_only" ? { attention: { operation: "raise" as const, code: "collection.metadata_only", retryable: true, severity: "low" as const, source: "collection" as const } } : {}),
      });
      if (!after.ok) return { outcome: "preserved", articleId: String(existing.id), canonicalUrl: canonical, contentHash, status };
    }
    await core.prepare(`UPDATE articles SET original_url=?, original_title=?, original_published_at=?, fetched_at=?, summarized_at=NULL, status=?, korean_title=NULL, summary_json=NULL,
      translation_status=?,translation_started_at=NULL,translated_at=NULL,translation_provider=NULL,translation_model=NULL,translation_attempt_count=0,
      translation_error_code=NULL,translation_error_summary=NULL,translation_next_attempt_at=NULL,
      cleaned_text=?, content_hash=?, source_metadata=?, raw_text_storage_ref=?, raw_text_blob_hash=?, raw_text_blob_size=?, raw_text_externalized_at=?, raw_text_blob_contract_version=?, review_state=?, updated_at=? WHERE id=?`)
      .bind(candidate.url, candidate.title, candidate.publishedAt ?? null, fetchedAt, legacyStatus, translationStatus, clean, contentHash, data, rawRef, rawHash, String(rawBytes.byteLength), fetchedAt, "worldcons-article-raw-blob-v1", status === "needs_review" && existing.review_state !== "closed_private" ? "needs_triage" : existing.review_state ?? null, fetchedAt, existing.id).run();
    return { outcome: "refreshed", articleId: String(existing.id), canonicalUrl: canonical, contentHash, status };
  }
  const id = crypto.randomUUID();
  const source = await core.prepare("SELECT id FROM sources WHERE source_key=? LIMIT 1").bind(candidate.sourceKey).first<{ id: string }>();
  await core.prepare(`INSERT INTO articles (id, source_id, source_key, jurisdiction, institution_name, content_type, original_url, canonical_url, original_language, original_title, original_published_at, discovered_at, fetched_at, status, slug, translation_status, cleaned_text, content_hash, source_metadata, created_at, updated_at, review_state, raw_text_storage_ref, raw_text_blob_hash, raw_text_blob_size, raw_text_externalized_at, raw_text_blob_contract_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, source?.id ?? null, candidate.sourceKey, SOURCE_INFO[candidate.sourceKey].jurisdiction, SOURCE_INFO[candidate.sourceKey].name, candidate.contentType, candidate.url, canonical, SOURCE_INFO[candidate.sourceKey].language, candidate.title, candidate.publishedAt ?? null, fetchedAt, fetchedAt, legacyStatus, slug, translationStatus, clean, contentHash, data, fetchedAt, fetchedAt, null, rawRef, rawHash, String(rawBytes.byteLength), fetchedAt, "worldcons-article-raw-blob-v1").run();
  const lifecycle = await transitionArticleLifecycleInD1(core as unknown as D1RuntimeDatabase, {
    articleId: id,
    expectedRevision: 0,
    idempotencyKey: `native-crawler:${runId}:${contentHash}`,
    actorType: "ingestion",
    actorId: "worldcons-ingest-native-v1",
    source: "ingestion.refresh",
    reasonCode: "source_content_collected",
    collectionState: status === "cleaned" ? "source_text_ready" : "metadata_only",
    processingState: status === "cleaned" ? "ready" : "not_ready",
    reviewState: status === "needs_review" ? "needs_review" : "unreviewed",
    ...(status !== "cleaned" ? { attention: { operation: "raise" as const, code: candidate.sourceKey === "us-scotus" ? "collection.pdf_text_unavailable" : "collection.metadata_only", retryable: true, severity: "low" as const, source: "collection" as const } } : {}),
  });
  if (!lifecycle.ok) throw new Error(`crawler.lifecycle_transition_failed:${lifecycle.error.code}`);
  if (status === "needs_review") await core.prepare("UPDATE articles SET review_state=? WHERE id=?").bind("needs_triage", id).run();
  return { outcome: "inserted", articleId: id, canonicalUrl: canonical, contentHash, status };
}

function effectiveRange(source: NativeCrawlerSource, now: Date, configured?: number) {
  const floor = SOURCE_INFO[source].rangeDays;
  if (source === "es-tribunal-constitucional") return Math.min(730, Math.max(floor, configured ?? 0));
  return Math.max(floor, configured ?? 0);
}

async function discoverCandidates(source: NativeCrawlerSource, bindings: NativeCrawlerBindings, fetcher: typeof fetch, robotsCache: Map<string, string>, lastRequest: Map<string, number>, allowBrowser: boolean, limit: number, rangeStart: number, now: Date, browserNavigate?: CrawlerOptions["browserNavigate"], bverfgOutcome?: BverfgDiscoverySelection) {
  const base = SOURCE_INFO[source].baseUrl;
  if (source === "us-scotus") {
    const term = String(now.getUTCMonth() >= 9 ? now.getUTCFullYear() : now.getUTCFullYear() - 1).slice(-2);
    const url = `${base}/opinions/slipopinion/${term}`;
    const result = await fetchHtml(source, url, bindings, fetcher, robotsCache, lastRequest, allowBrowser, browserNavigate);
    return discoverScotus(result.html, url).filter((item) => withinRange(item.publishedAt, rangeStart) || withinRange(typeof item.metadata.revisionDate === "string" ? item.metadata.revisionDate : undefined, now.getTime() - 90 * 86_400_000)).slice(0, limit + 100);
  }
  if (source === "de-bverfg") {
    const url = `${base}/DE/Entscheidungen/entscheidungen_node.html`;
    let windowCandidates: NativeArticleCandidate[] | null = null;
    try {
      const result = await fetchHtml(source, url, bindings, fetcher, robotsCache, lastRequest, allowBrowser, browserNavigate);
      const listing = discoverBverfg(result.html, url, BVERFG_INDEX_SCAN_WINDOW).filter((item) => withinRange(item.publishedAt, rangeStart));
      if (listing.length > 0) windowCandidates = listing;
    } catch (error) {
      if (!isTransientCrawlerHttpError(error)) throw error;
    }
    if (!windowCandidates) {
      // Third-party index is discovery-only; scanning its finite newest window
      // lets D1-aware selection skip a cooldown 404 head candidate. Errors
      // (including 429) still propagate so the run-level degraded handling is
      // unchanged.
      windowCandidates = await discoverBverfgOpenLegalData(fetcher, rangeStart, Math.max(limit, BVERFG_INDEX_SCAN_WINDOW));
    }
    const tracked = await loadBverfgTrackedCandidates(bindings.WORLDCONS_INGEST, windowCandidates.flatMap(bverfgCandidateLookupUrls));
    const selection = selectBverfgDiscoveryCandidates(windowCandidates, tracked, limit, now);
    if (bverfgOutcome) {
      bverfgOutcome.selected = selection.selected;
      bverfgOutcome.deferred = selection.deferred;
      bverfgOutcome.alreadyFetched = selection.alreadyFetched;
    }
    return selection.selected;
  }
  if (source === "fr-conseil-constitutionnel") {
    const url = `${base}/les-decisions`;
    const result = await fetchHtml(source, url, bindings, fetcher, robotsCache, lastRequest, allowBrowser, browserNavigate);
    return discoverFrance(result.html, url).filter((item) => withinRange(item.publishedAt, rangeStart)).slice(0, limit);
  }
  const indexUrl = `${base}/HJ/es/Busqueda/Index`;
  const indexResult = await fetchHtml(source, indexUrl, bindings, fetcher, robotsCache, lastRequest, allowBrowser, browserNavigate);
  const direct = discoverSpain(indexResult.html, indexUrl).filter((item) => withinRange(item.publishedAt, rangeStart)).slice(0, limit);
  if (direct.length > 0) return direct;
  const searched = await discoverSpainSearch(fetcher, robotsCache, lastRequest, rangeStart, limit);
  if (searched.length > 0) return searched;
  return discoverSpainTail(bindings, fetcher, robotsCache, lastRequest, rangeStart, limit, browserNavigate);
}

async function fetchCandidate(candidate: NativeArticleCandidate, bindings: NativeCrawlerBindings, fetcher: typeof fetch, robotsCache: Map<string, string>, lastRequest: Map<string, number>, allowBrowser: boolean, browserNavigate?: CrawlerOptions["browserNavigate"]) {
  if (candidate.sourceKey === "us-scotus") return { text: `${candidate.title}\n${candidate.publishedAt ?? ""}\n${candidate.url}`, status: 200, fetched: false };
  if (candidate.sourceKey === "de-bverfg" && candidate.metadata.discoveryIndex === "openlegaldata") {
    const configured = Array.isArray(candidate.metadata.officialUrlCandidates)
      ? candidate.metadata.officialUrlCandidates.filter((value): value is string => typeof value === "string" && officialHost("de-bverfg", value))
      : [candidate.url];
    let sawTransient5xx = false;
    for (const officialUrl of configured) {
      try {
        const result = await fetchHtml(candidate.sourceKey, officialUrl, bindings, fetcher, robotsCache, lastRequest, allowBrowser, browserNavigate);
        const verifiedText = acceptBverfgOfficialVerification(candidate, result.html, result.finalUrl, officialUrl);
        return { text: verifiedText, status: result.status, fetched: true };
      } catch (error) {
        if (error instanceof Error && error.message === "crawler.http_404") continue;
        if (isTransientCrawlerHttpError(error)) {
          sawTransient5xx = true;
          continue;
        }
        throw error;
      }
    }
    if (sawTransient5xx) candidate.metadata.fetchUnavailableCode = "BVERFG_OFFICIAL_TRANSIENT_5XX";
    return { text: "", status: 404, fetched: false };
  }
  if (candidate.sourceKey === "es-tribunal-constitucional") {
    const jsonId = candidate.metadata.hjId;
    if (typeof jsonId === "string" && /^\d+$/.test(jsonId)) {
      const payload = await fetchSpainJson(fetcher, bindings, robotsCache, lastRequest, Number(jsonId), browserNavigate);
      if (payload) {
        const refreshed = spainPayloadCandidate(payload, Number(jsonId));
        if (refreshed) {
          candidate.title = refreshed.title;
          candidate.publishedAt = refreshed.publishedAt ?? candidate.publishedAt;
          candidate.contentType = refreshed.contentType;
          candidate.metadata = { ...candidate.metadata, ...refreshed.metadata };
        }
        const text = spainPayloadText(payload);
        const irrelevant = payload.CONTENIDO_IRRELEVANTE_PARA_INTERNET === true
          || /no incorpora doctrina constitucional|no contiene doctrina constitucional/i.test(String(payload.AVISO ?? ""));
        const collection = candidate.metadata.collection as Record<string, unknown>;
        collection.sourceUrlVerified = true;
        collection.strictSourceTextAvailable = true;
        if (irrelevant) {
          candidate.metadata.review = { required: true, reason: "official_metadata_requires_review" };
          collection.sourceTextAvailable = false;
          collection.publishable = false;
          return { text: `${candidate.title}\n${candidate.url}`, status: 200, fetched: true };
        }
        const sufficient = text.length >= 2_000;
        collection.sourceTextAvailable = sufficient;
        collection.publishable = sufficient;
        if (!sufficient) candidate.metadata.review = { required: true, reason: "strict_source_text_gate_failed" };
        return { text: sufficient ? text : `${candidate.title}\n${candidate.url}`, status: 200, fetched: true };
      }
    }
    candidate.metadata.review = { required: true, reason: "official_json_unavailable" };
    const collection = candidate.metadata.collection as Record<string, unknown>;
    collection.strictSourceTextAvailable = true;
    collection.sourceTextAvailable = false;
    collection.publishable = false;
    return { text: `${candidate.title}\n${candidate.publishedAt ?? ""}\n${candidate.url}`, status: 0, fetched: false };
  }
  const result = await fetchHtml(candidate.sourceKey, candidate.url, bindings, fetcher, robotsCache, lastRequest, allowBrowser, browserNavigate);
  if (candidate.sourceKey === "de-bverfg") {
    const verifiedText = acceptBverfgOfficialVerification(candidate, result.html, result.finalUrl, candidate.url);
    return { text: verifiedText, status: result.status, fetched: true };
  }
  (candidate.metadata.collection as Record<string, unknown>).sourceUrlVerified = true;
  return { text: extractOfficialText(result.html, candidate.sourceKey), status: result.status, fetched: true };
}

export async function runNativeSourceCollection(source: NativeCrawlerSource, bindings: NativeCrawlerBindings, options: CrawlerOptions = {}) {
  const startedAt = (options.now ?? new Date()).toISOString();
  const runId = options.idempotencyKey
    ? await (async () => {
      const hash = await sha256(`${source}:${options.idempotencyKey}`);
      return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    })()
    : crypto.randomUUID();
  const fetcher = options.fetch ?? fetch;
  const limit = Math.max(1, Math.min(20, Math.trunc(options.limit ?? 20)));
  const rangeDays = effectiveRange(source, options.now ?? new Date(), options.rangeDays);
  const rangeStart = (options.now ?? new Date()).getTime() - rangeDays * 86_400_000;
  const robotsCache = new Map<string, string>();
  const lastRequest = new Map<string, number>();
  let discovered: NativeArticleCandidate[] = [];
  let fetchedCount = 0;
  let failedCount = 0;
  let insertedCount = 0;
  let refreshedCount = 0;
  let unchangedCount = 0;
  let preservedCount = 0;
  let duplicateCount = 0;
  let uncollectedCount = 0;
  let lastVerifiedPublishedAt: string | null = null;
  let discoveryUnavailableCode: string | null = null;
  const failures: Array<{ url: string; code: string }> = [];
  const existingRun = options.idempotencyKey
    ? await bindings.WORLDCONS_INGEST.prepare("SELECT status, metadata FROM ingestion_runs WHERE id=?").bind(runId).first<{ status: string; metadata: string | null }>()
    : null;
  if (existingRun?.status === "completed") {
    const metadata = JSON.parse(existingRun.metadata ?? "{}") as Record<string, unknown>;
    return { sourceKey: source, runId, status: existingRun.status, outcome: metadata.outcome === "success" || metadata.outcome === "partial" ? metadata.outcome : "degraded", discoveredCount: Number(metadata.discoveredCount ?? 0), fetchedCount: Number(metadata.fetchedCount ?? 0), insertedCount: Number(metadata.insertedCount ?? 0), refreshedCount: Number(metadata.refreshedCount ?? 0), unchangedCount: Number(metadata.unchangedCount ?? 0), preservedCount: Number(metadata.preservedCount ?? 0), duplicateCount: Number(metadata.duplicateCount ?? 0), uncollectedCount: Number(metadata.uncollectedCount ?? 0), failedCount: Number(metadata.failedCount ?? 0), rangeDays, lastVerifiedPublishedAt: typeof metadata.lastVerifiedPublishedAt === "string" ? metadata.lastVerifiedPublishedAt : null, replayed: true };
  }
  await bindings.WORLDCONS_INGEST.prepare("INSERT INTO ingestion_runs (id, source_key, started_at, status, discovered_count, fetched_count, summarized_count, failed_count, metadata) VALUES (?, ?, ?, 'running', 0, 0, 0, 0, ?) ON CONFLICT(id) DO NOTHING").bind(runId, source, startedAt, JSON.stringify({ crawler: "worldcons-ingest-native-v1", rangeDays, limit, refreshExisting: true, idempotencyKey: options.idempotencyKey ?? null })).run();
  try {
    const priorRuns = await bindings.WORLDCONS_INGEST.prepare("SELECT metadata, started_at, finished_at FROM ingestion_runs WHERE source_key=? AND status='completed' ORDER BY finished_at DESC LIMIT 8").bind(source).all<{ metadata: string | null; started_at: string; finished_at: string | null }>();
    const latest = priorRuns.results?.[0];
    const incrementalDays = latest?.finished_at ? Math.max(rangeDays, Math.min(365, Math.ceil((Date.parse(startedAt) - Date.parse(latest.finished_at)) / 86_400_000) + 2)) : rangeDays;
    const effectiveStart = Date.parse(startedAt) - incrementalDays * 86_400_000;
    const bverfgDiscovery: BverfgDiscoverySelection = { selected: [], deferred: 0, alreadyFetched: 0 };
    try {
      discovered = await discoverCandidates(source, bindings, fetcher, robotsCache, lastRequest, true, limit, effectiveStart, options.now ?? new Date(), options.browserNavigate, bverfgDiscovery);
    } catch (error) {
      if (source === "de-bverfg" && error instanceof Error && error.message === "crawler.bverfg_index_http_429") {
        discoveryUnavailableCode = "BVERFG_DISCOVERY_RATE_LIMITED_429";
      } else {
        throw error;
      }
    }
    if (source === "de-bverfg" && discovered.length === 0 && bverfgDiscovery.deferred > 0) {
      discoveryUnavailableCode = "BVERFG_CANDIDATES_DEFERRED_BACKOFF";
    }
    const primary = discovered.filter((item) => withinRange(item.publishedAt, effectiveStart)
      || (item.sourceKey === "es-tribunal-constitucional" && item.metadata.discoveryIndex === "official-search"));
    const revisions = source === "us-scotus"
      ? discovered.filter((item) => !withinRange(item.publishedAt, effectiveStart) && withinRange(typeof item.metadata.revisionDate === "string" ? item.metadata.revisionDate : undefined, Date.parse(startedAt) - 90 * 86_400_000)).slice(0, 100)
      : [];
    const bounded = [...primary.slice(0, limit), ...revisions];
    for (const candidate of bounded) {
      const fetchedAt = new Date().toISOString();
      try {
        if (!officialHost(source, candidate.url)) throw new Error("crawler.non_official_host");
        const fetched = await fetchCandidate(candidate, bindings, fetcher, robotsCache, lastRequest, true, options.browserNavigate);
        const collection = candidate.metadata.collection as Record<string, unknown>;
        if (!fetched.fetched) {
          uncollectedCount += 1;
          const unavailableCode = source === "de-bverfg"
            ? (typeof candidate.metadata.fetchUnavailableCode === "string" ? candidate.metadata.fetchUnavailableCode : "BVERFG_OFFICIAL_VARIANTS_404")
            : source === "es-tribunal-constitucional" ? "SPAIN_SOURCE_TEXT_UNAVAILABLE" : "PDF_TEXT_EXTRACTION_UNAVAILABLE";
          const unavailableMessage = source === "de-bverfg"
            ? unavailableCode === "BVERFG_OFFICIAL_TRANSIENT_5XX"
              ? "Official BVerfG endpoints are temporarily unavailable; keep the discovery candidate for bounded recheck."
              : "Official BVerfG URL variants are not published yet; keep the discovery candidate for bounded recheck."
            : source === "es-tribunal-constitucional"
              ? "Official Spain HJ listing metadata is preserved; JSON source text is temporarily unavailable."
              : "Official PDF metadata preserved; source text awaits review.";
          await upsertCandidate(bindings.WORLDCONS_INGEST, source, candidate.url, unavailableCode, unavailableMessage, false);
          if (source === "de-bverfg") continue;
        } else {
          fetchedCount += 1;
          await upsertCandidate(bindings.WORLDCONS_INGEST, source, candidate.url, null, null, true);
        }
        const persisted = await persistArticle(bindings, candidate, fetched.text, runId, fetchedAt);
        const outcome = persisted.outcome;
        if (outcome === "inserted") insertedCount += 1;
        else if (outcome === "refreshed") refreshedCount += 1;
        else if (outcome === "unchanged") unchangedCount += 1;
        else if (outcome === "preserved") preservedCount += 1;
        else if (outcome === "duplicate") duplicateCount += 1;
        if (collection.sourceTextAvailable === true && candidate.publishedAt && (!lastVerifiedPublishedAt || candidate.publishedAt > lastVerifiedPublishedAt)) lastVerifiedPublishedAt = candidate.publishedAt;
      } catch (error) {
        failedCount += 1;
        const code = error instanceof Error ? error.message.slice(0, 120) : "crawler.unknown_error";
        failures.push({ url: candidate.url, code });
        await upsertCandidate(bindings.WORLDCONS_INGEST, source, candidate.url, code, code, false).catch(() => undefined);
      }
    }
    const status = discoveryUnavailableCode
      ? "completed"
      : failedCount > 0 && fetchedCount === 0 && uncollectedCount === 0 ? "failed" : "completed";
    const outcome = discoveryUnavailableCode
      ? "degraded"
      : failedCount === 0 && uncollectedCount === 0 ? "success" : fetchedCount + insertedCount + refreshedCount > 0 ? "partial" : "degraded";
    const metadata = { crawler: "worldcons-ingest-native-v1", limit, rangeDays, incrementalRangeDays: Math.ceil((Date.parse(startedAt) - effectiveStart) / 86_400_000), discoveredCount: bounded.length, discoveredBeforeFilterCount: discovered.length, ...(source === "de-bverfg" ? { bverfgDiscovery: { scanWindow: BVERFG_INDEX_SCAN_WINDOW, selectedFromWindow: bverfgDiscovery.selected.length, deferredCooldown: bverfgDiscovery.deferred, alreadyFetched: bverfgDiscovery.alreadyFetched } } : {}), fetchedCount, insertedCount, refreshedCount, unchangedCount, preservedCount, duplicateCount, uncollectedCount, failedCount, outcome, discoveryUnavailableCode, failures, lastVerifiedPublishedAt, revisionRecheckDays: source === "us-scotus" ? 90 : null, revisionRecheckLimit: source === "us-scotus" ? 100 : null, idempotencyKey: options.idempotencyKey ?? null };
    const errorMessage = discoveryUnavailableCode
      ?? (failures.length ? failures.slice(0, 5).map((failure) => `${failure.code}`).join("; ").slice(0, 2_000) : null);
    await bindings.WORLDCONS_INGEST.prepare("UPDATE ingestion_runs SET finished_at=?, status=?, discovered_count=?, fetched_count=?, failed_count=?, error_message=?, metadata=? WHERE id=?").bind(new Date().toISOString(), status, bounded.length, fetchedCount, failedCount, errorMessage, JSON.stringify(metadata), runId).run();
    return { sourceKey: source, runId, status, outcome, discoveredCount: bounded.length, fetchedCount, insertedCount, refreshedCount, unchangedCount, preservedCount, duplicateCount, uncollectedCount, failedCount, discoveryUnavailableCode, failures, rangeDays, lastVerifiedPublishedAt };
  } catch (error) {
    failedCount += 1;
    const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
    await bindings.WORLDCONS_INGEST.prepare("UPDATE ingestion_runs SET finished_at=?, status='failed', discovered_count=?, fetched_count=?, failed_count=?, error_message=?, metadata=? WHERE id=?").bind(new Date().toISOString(), discovered.length, fetchedCount, failedCount, message, JSON.stringify({ crawler: "worldcons-ingest-native-v1", rangeDays, limit, failures }), runId).run();
    throw error;
  }
}

export function effectiveNativeRangeDays(source: NativeCrawlerSource, configured?: number) {
  return effectiveRange(source, new Date(), configured);
}

export function parseNativeSourceListing(source: NativeCrawlerSource, html: string, baseUrl = SOURCE_INFO[source].baseUrl) {
  if (source === "de-bverfg") return discoverBverfg(html, baseUrl);
  if (source === "fr-conseil-constitutionnel") return discoverFrance(html, baseUrl);
  if (source === "us-scotus") return discoverScotus(html, baseUrl);
  return discoverSpain(html, baseUrl);
}

/** A compact, serializable description of one discovered target record. */
export interface NativeStageCandidate {
  sourceKey: NativeCrawlerSource;
  url: string;
  title: string;
  publishedAt?: string;
  contentType: NativeArticleCandidate["contentType"];
  metadata: Record<string, unknown>;
}

export interface NativeStageCrawlResult {
  fetched: boolean;
  status: number;
  text: string;
  canonicalUrl: string;
  candidate: NativeStageCandidate;
}

/** Stable per-record identity used as the durable stage-job article id. */
export async function nativeStageCandidateId(sourceKey: string, canonicalUrl: string): Promise<string> {
  return `native:${(await sha256(`${sourceKey}\u001f${canonicalUrl}`)).slice(0, 32)}`;
}

/** Deterministic R2 key for the crawl stage's raw fetched artifact. */
export function nativeStageCrawlArtifactKey(sourceKey: string, contentHash: string): string {
  return `stages/ingest-crawl/${sourceKey}/${contentHash}.json`;
}

export function parseNativeStageCandidate(value: unknown): NativeStageCandidate | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate); } catch { return null; }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const record = candidate as Record<string, unknown>;
  if (typeof record.sourceKey !== "string" || !(NATIVE_CRAWLER_SOURCES as readonly string[]).includes(record.sourceKey)) return null;
  if (typeof record.url !== "string" || !record.url) return null;
  if (typeof record.title !== "string") return null;
  if (record.contentType !== "decision" && record.contentType !== "opinion" && record.contentType !== "order") return null;
  if (record.publishedAt !== undefined && typeof record.publishedAt !== "string") return null;
  if (record.metadata !== undefined && (typeof record.metadata !== "object" || record.metadata === null || Array.isArray(record.metadata))) return null;
  return {
    sourceKey: record.sourceKey as NativeCrawlerSource,
    url: record.url,
    title: record.title,
    ...(record.publishedAt ? { publishedAt: record.publishedAt } : {}),
    contentType: record.contentType,
    metadata: (record.metadata as Record<string, unknown> | undefined) ?? {},
  };
}

/**
 * Discovers the bounded set of candidate records for one source using the real
 * official listing parsers. This is the *discovery stage* input: it returns
 * candidates to be fetched one-by-one by the crawl stage, and never fetches the
 * article bodies itself.
 */
export async function discoverNativeStageCandidates(
  source: NativeCrawlerSource,
  bindings: NativeCrawlerBindings,
  options: { fetch?: typeof fetch; now?: Date; limit?: number; rangeDays?: number; browserNavigate?: CrawlerOptions["browserNavigate"] },
): Promise<NativeStageCandidate[]> {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(20, Math.trunc(options.limit ?? 20)));
  const rangeDays = effectiveRange(source, now, options.rangeDays);
  const rangeStart = now.getTime() - rangeDays * 86_400_000;
  const robotsCache = new Map<string, string>();
  const lastRequest = new Map<string, number>();
  const discovered = await discoverCandidates(source, bindings, fetcher, robotsCache, lastRequest, true, limit, rangeStart, now, options.browserNavigate);
  const primary = discovered.filter((item) => withinRange(item.publishedAt, rangeStart)
    || (item.sourceKey === "es-tribunal-constitucional" && item.metadata.discoveryIndex === "official-search"));
  return primary.slice(0, limit).map((candidate) => ({
    sourceKey: candidate.sourceKey,
    url: candidate.url,
    title: candidate.title,
    ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt } : {}),
    contentType: candidate.contentType,
    metadata: candidate.metadata,
  }));
}

/**
 * Fetches exactly one discovered candidate from its official URL. This is the
 * crawl stage: it performs a targeted single-record fetch (never a whole-source
 * crawl) and returns the raw text for the normalize stage to clean and persist.
 */
export async function crawlNativeStageCandidate(
  candidate: NativeStageCandidate,
  bindings: NativeCrawlerBindings,
  options: { fetch?: typeof fetch; now?: Date; browserNavigate?: CrawlerOptions["browserNavigate"] } = {},
): Promise<NativeStageCrawlResult> {
  const fetcher = options.fetch ?? fetch;
  const robotsCache = new Map<string, string>();
  const lastRequest = new Map<string, number>();
  const internal: NativeArticleCandidate = {
    sourceKey: candidate.sourceKey,
    url: candidate.url,
    title: candidate.title,
    ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt } : {}),
    contentType: candidate.contentType,
    metadata: candidate.metadata,
  };
  if (!officialHost(candidate.sourceKey, candidate.url)) throw new Error("crawler.non_official_host");
  const fetched = await fetchCandidate(internal, bindings, fetcher, robotsCache, lastRequest, true, options.browserNavigate);
  const canonical = canonicalUrl(internal.url, internal.url);
  // A German fallback may resolve a different official URL, and Spanish JSON
  // may correct the title/date/provenance. Normalize must persist the verified
  // candidate, not the stale discovery snapshot.
  return {
    fetched: fetched.fetched,
    status: fetched.status,
    text: fetched.text,
    canonicalUrl: canonical,
    candidate: { ...internal, url: canonical },
  };
}

/**
 * Cleans and persists one crawled record into the core DB. This is the normalize
 * stage's durable write: it reuses the exact audited `persistArticle` path
 * (status derivation, publishability gates, lifecycle, R2 raw snapshot) so the
 * staged pipeline can never diverge from the legacy collection semantics.
 */
export async function persistNativeStageRecord(
  candidate: NativeStageCandidate,
  text: string,
  bindings: NativeCrawlerBindings,
  options: { runId: string; fetchedAt: string },
): Promise<NativePersistResult> {
  const internal: NativeArticleCandidate = {
    sourceKey: candidate.sourceKey,
    url: candidate.url,
    title: candidate.title,
    ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt } : {}),
    contentType: candidate.contentType,
    metadata: candidate.metadata,
  };
  return persistArticle(bindings, internal, text, options.runId, options.fetchedAt);
}
