/**
 * Bounded, read-only production sitemap parity probe.
 *
 * Performs exactly two sequential GET requests to the fixed production sitemap
 * endpoint, validates the XML and canonical URL safety, and reports counts plus
 * a sorted normalized URL-set SHA-256. It never prints the URL list, never
 * alters Cloudflare/Google state, and never follows redirects.
 *
 * Usage:
 *   pnpm seo:sitemap:probe
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const SITEMAP_PROBE_URL = "https://worldcons.cclib.workers.dev/sitemap.xml";
export const SITEMAP_PROBE_ORIGIN = new URL(SITEMAP_PROBE_URL).origin;
export const SITEMAP_PROBE_RUNS = 2;
export const SITEMAP_PROBE_GAP_MS = 1_000;
export const SITEMAP_PROBE_TIMEOUT_MS = 30_000;
export const SITEMAP_PROBE_MAX_BYTES = 2 * 1024 * 1024;

export type SitemapProbeErrorCode =
  | "http_status"
  | "malformed_xml"
  | "no_article_urls"
  | "cross_origin"
  | "duplicate_urls"
  | "response_too_large"
  | "run_mismatch"
  | "timeout"
  | "network_error"
  | "unsafe_url";

export class SitemapProbeError extends Error {
  readonly code: SitemapProbeErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: SitemapProbeErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SitemapProbeError";
    this.code = code;
    this.details = details;
  }
}

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export interface ParsedSitemap {
  entries: SitemapEntry[];
}

export interface SitemapAnalysis {
  urlCount: number;
  articleUrlCount: number;
  uniqueCount: number;
  duplicateCount: number;
  urlSetSha256: string;
  lastmodCount: number;
  xmlValid: true;
  canonicalSafe: boolean;
  sameOrigin: boolean;
  crossOriginUrlCount: number;
  nonHttpsUrlCount: number;
  invalidUrlCount: number;
  credentialUrlCount: number;
  fragmentUrlCount: number;
  queryUrlCount: number;
}

export interface SitemapProbeRun extends SitemapAnalysis {
  run: number;
  httpStatus: number;
  ttfbMs: number;
  totalMs: number;
  bytes: number;
  contentType: string | null;
  redirected: boolean;
}

export interface SitemapProbeReport {
  event: "worldcons_seo_sitemap_probe";
  endpoint: typeof SITEMAP_PROBE_URL;
  runs: SitemapProbeRun[];
  bothRunsMatch: boolean;
  mismatchFields: string[];
}

export type SitemapProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SitemapProbeOptions {
  fetchImpl?: SitemapProbeFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  gapMs?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface CaptureSegment {
  text: string;
  cdata: boolean;
}

interface Capture {
  name: "loc" | "lastmod";
  segments: CaptureSegment[];
}

function malformed(): never {
  throw new SitemapProbeError("malformed_xml", "Sitemap XML is malformed or unsupported.");
}

function localName(name: string): string {
  const separator = name.indexOf(":");
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function decodeEntities(value: string): string {
  let output = "";
  let index = 0;
  while (index < value.length) {
    const ampersand = value.indexOf("&", index);
    if (ampersand < 0) {
      output += value.slice(index);
      break;
    }
    output += value.slice(index, ampersand);
    const semicolon = value.indexOf(";", ampersand + 1);
    if (semicolon < 0) malformed();
    const entity = value.slice(ampersand + 1, semicolon);
    if (!entity) malformed();
    if (entity === "amp") output += "&";
    else if (entity === "lt") output += "<";
    else if (entity === "gt") output += ">";
    else if (entity === "quot") output += '"';
    else if (entity === "apos") output += "'";
    else if (/^#[0-9]+$/u.test(entity) || /^#x[0-9A-Fa-f]+$/u.test(entity)) {
      const codePoint = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) malformed();
      output += String.fromCodePoint(codePoint);
    } else {
      malformed();
    }
    index = semicolon + 1;
  }
  return output;
}

function decodeCapture(capture: Capture): string {
  return capture.segments
    .map((segment) => (segment.cdata ? segment.text : decodeEntities(segment.text)))
    .join("")
    .trim();
}

function findTagEnd(source: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return malformed();
}

function validateAttributes(value: string): void {
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/u.test(value[index])) index += 1;
    if (index >= value.length) return;
    const match = /^([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("[^"]*"|'[^']*')/u.exec(value.slice(index));
    if (!match) malformed();
    index += match[0].length;
  }
}

export function parseSitemapXml(xml: string): ParsedSitemap {
  if (typeof xml !== "string") malformed();
  const source = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  if (!source.trim()) malformed();

  const entries: SitemapEntry[] = [];
  const stack: string[] = [];
  let rootSeen = false;
  let rootClosed = false;
  let currentUrl: { loc?: string; lastmod?: string } | null = null;
  let capture: Capture | null = null;
  let index = 0;

  const appendText = (text: string, cdata = false) => {
    if (!text) return;
    if (stack.length === 0) {
      if (text.trim()) malformed();
      return;
    }
    if (capture) {
      capture.segments.push({ text, cdata });
      return;
    }
    const parent = localName(stack[stack.length - 1]);
    if ((parent === "urlset" || parent === "url") && text.trim()) malformed();
  };

  const openElement = (name: string, local: string) => {
    if (stack.length === 0) {
      if (rootSeen || rootClosed) malformed();
      if (local !== "urlset") malformed();
      rootSeen = true;
    } else if (rootClosed) {
      malformed();
    }

    if (capture) malformed();

    if (local === "url" && stack.length === 1 && localName(stack[0]) === "urlset") {
      if (currentUrl) malformed();
      currentUrl = {};
    } else if (
      (local === "loc" || local === "lastmod") &&
      stack.length === 2 &&
      localName(stack[1]) === "url" &&
      currentUrl
    ) {
      capture = { name: local, segments: [] };
    }
  };

  const closeElement = (name: string, local: string) => {
    if (stack.length === 0 || stack[stack.length - 1] !== name) malformed();

    if (capture) {
      if (capture.name !== local) malformed();
      const value = decodeCapture(capture);
      if (local === "loc") {
        if (!currentUrl || !value || currentUrl.loc !== undefined) malformed();
        currentUrl.loc = value;
      } else {
        if (!currentUrl || currentUrl.lastmod !== undefined) malformed();
        currentUrl.lastmod = value;
      }
      capture = null;
    }

    stack.pop();

    if (local === "url" && stack.length === 1 && localName(stack[0]) === "urlset") {
      if (!currentUrl || !currentUrl.loc) malformed();
      entries.push({ loc: currentUrl.loc, lastmod: currentUrl.lastmod || null });
      currentUrl = null;
    }

    if (stack.length === 0) rootClosed = true;
  };

  while (index < source.length) {
    if (source[index] !== "<") {
      const next = source.indexOf("<", index);
      const end = next < 0 ? source.length : next;
      appendText(source.slice(index, end));
      index = end;
      continue;
    }

    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      if (end < 0) malformed();
      index = end + 3;
      continue;
    }

    if (source.startsWith("<![CDATA[", index)) {
      const end = source.indexOf("]]>", index + 9);
      if (end < 0) malformed();
      appendText(source.slice(index + 9, end), true);
      index = end + 3;
      continue;
    }

    if (source.startsWith("<?", index)) {
      const end = source.indexOf("?>", index + 2);
      if (end < 0 || rootSeen) malformed();
      index = end + 2;
      continue;
    }

    if (source.startsWith("<!DOCTYPE", index) || source.startsWith("<!ENTITY", index) || source.startsWith("<!", index)) {
      malformed();
    }

    const end = findTagEnd(source, index + 1);
    const raw = source.slice(index + 1, end).trim();
    index = end + 1;
    if (!raw) malformed();

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/u.test(name)) malformed();
      closeElement(name, localName(name));
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const content = selfClosing ? raw.slice(0, -1).trim() : raw;
    const match = /^([A-Za-z_:][A-Za-z0-9_.:-]*)([\s\S]*)$/u.exec(content);
    if (!match) malformed();
    const name = match[1];
    const local = localName(name);
    validateAttributes(match[2].trim());

    if (selfClosing) {
      if (local === "urlset") {
        if (stack.length !== 0 || rootSeen || rootClosed) malformed();
        rootSeen = true;
        rootClosed = true;
      } else if (local === "url" || local === "loc" || local === "lastmod") {
        malformed();
      }
      continue;
    }

    openElement(name, local);
    stack.push(name);
  }

  if (!rootSeen || !rootClosed || stack.length !== 0 || capture || currentUrl) malformed();
  return { entries };
}

function normalizeUrl(url: URL): string {
  const normalized = new URL(url.href);
  normalized.hash = "";
  normalized.hostname = normalized.hostname.toLowerCase();
  if (
    (normalized.protocol === "https:" && normalized.port === "443") ||
    (normalized.protocol === "http:" && normalized.port === "80")
  ) {
    normalized.port = "";
  }
  if (!normalized.pathname) normalized.pathname = "/";
  if (normalized.pathname.length > 1 && normalized.pathname.endsWith("/")) {
    normalized.pathname = normalized.pathname.slice(0, -1);
  }
  return normalized.href;
}

function isArticleUrl(url: URL): boolean {
  return url.pathname.startsWith("/articles/") && url.pathname.length > "/articles/".length;
}

export function analyzeSitemapXml(xml: string): SitemapAnalysis {
  const { entries } = parseSitemapXml(xml);
  const normalized = new Set<string>();
  let articleUrlCount = 0;
  let lastmodCount = 0;
  let canonicalSafe = true;
  let sameOrigin = true;
  let crossOriginUrlCount = 0;
  let nonHttpsUrlCount = 0;
  let invalidUrlCount = 0;
  let credentialUrlCount = 0;
  let fragmentUrlCount = 0;
  let queryUrlCount = 0;

  for (const entry of entries) {
    if (entry.lastmod) lastmodCount += 1;
    const raw = entry.loc;
    if (!raw || /\s/u.test(raw)) {
      invalidUrlCount += 1;
      canonicalSafe = false;
      normalized.add(raw);
      continue;
    }

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      invalidUrlCount += 1;
      canonicalSafe = false;
      normalized.add(raw);
      continue;
    }

    if (parsed.protocol !== "https:") {
      nonHttpsUrlCount += 1;
      canonicalSafe = false;
    }
    if (parsed.origin !== SITEMAP_PROBE_ORIGIN) {
      crossOriginUrlCount += 1;
      sameOrigin = false;
      canonicalSafe = false;
    }
    if (parsed.username || parsed.password) {
      credentialUrlCount += 1;
      canonicalSafe = false;
    }
    if (parsed.hash) {
      fragmentUrlCount += 1;
      canonicalSafe = false;
    }
    if (parsed.search) queryUrlCount += 1;
    if (isArticleUrl(parsed)) articleUrlCount += 1;

    normalized.add(normalizeUrl(parsed));
  }

  const sorted = [...normalized].sort();
  const urlSetSha256 = createHash("sha256").update(sorted.join("\n")).digest("hex");

  return {
    urlCount: entries.length,
    articleUrlCount,
    uniqueCount: normalized.size,
    duplicateCount: entries.length - normalized.size,
    urlSetSha256,
    lastmodCount,
    xmlValid: true,
    canonicalSafe,
    sameOrigin,
    crossOriginUrlCount,
    nonHttpsUrlCount,
    invalidUrlCount,
    credentialUrlCount,
    fragmentUrlCount,
    queryUrlCount,
  };
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await response.body?.cancel();
    throw new SitemapProbeError("response_too_large", "Sitemap response exceeds the byte limit.", {
      limitBytes: maxBytes,
    });
  }

  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SitemapProbeError("response_too_large", "Sitemap response exceeds the byte limit.", {
          limitBytes: maxBytes,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

async function probeRun(
  run: number,
  fetchImpl: SitemapProbeFetch,
  now: () => number,
  timeoutMs: number,
  maxBytes: number,
): Promise<SitemapProbeRun> {
  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(SITEMAP_PROBE_URL, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/xml, text/xml;q=0.9, */*;q=0.1" },
    });
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted || isAbortError(error)) {
      throw new SitemapProbeError("timeout", "Sitemap request timed out.", { run, timeoutMs });
    }
    throw new SitemapProbeError("network_error", "Sitemap request failed.", { run });
  }

  const ttfbMs = now() - startedAt;
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    clearTimeout(timer);
    throw new SitemapProbeError("http_status", `Sitemap endpoint returned HTTP ${response.status}.`, {
      run,
      status: response.status,
    });
  }

  let body: Uint8Array;
  try {
    body = await readLimitedBody(response, maxBytes);
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof SitemapProbeError) throw error;
    if (controller.signal.aborted || isAbortError(error)) {
      throw new SitemapProbeError("timeout", "Sitemap request timed out.", { run, timeoutMs });
    }
    throw new SitemapProbeError("network_error", "Sitemap response body could not be read.", { run });
  }
  clearTimeout(timer);

  const totalMs = now() - startedAt;
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new SitemapProbeError("malformed_xml", "Sitemap body is not valid UTF-8.", { run });
  }

  const analysis = analyzeSitemapXml(xml);
  if (!analysis.sameOrigin) {
    throw new SitemapProbeError("cross_origin", "Sitemap contains cross-origin URLs.", {
      run,
      crossOriginUrlCount: analysis.crossOriginUrlCount,
    });
  }
  if (!analysis.canonicalSafe) {
    throw new SitemapProbeError("unsafe_url", "Sitemap contains unsafe or non-canonical URLs.", {
      run,
      invalidUrlCount: analysis.invalidUrlCount,
      nonHttpsUrlCount: analysis.nonHttpsUrlCount,
      credentialUrlCount: analysis.credentialUrlCount,
      fragmentUrlCount: analysis.fragmentUrlCount,
    });
  }
  if (analysis.duplicateCount > 0) {
    throw new SitemapProbeError("duplicate_urls", "Sitemap contains duplicate normalized URLs.", {
      run,
      duplicateCount: analysis.duplicateCount,
    });
  }
  if (analysis.articleUrlCount === 0) {
    throw new SitemapProbeError("no_article_urls", "Sitemap contains zero article URLs.", { run });
  }

  return {
    run,
    ...analysis,
    httpStatus: response.status,
    ttfbMs,
    totalMs,
    bytes: body.byteLength,
    contentType: response.headers.get("content-type"),
    redirected: response.redirected,
  };
}

function compareRuns(runs: SitemapProbeRun[]): { bothRunsMatch: boolean; mismatchFields: string[] } {
  const fields: Array<keyof SitemapProbeRun> = [
    "httpStatus",
    "urlCount",
    "articleUrlCount",
    "uniqueCount",
    "duplicateCount",
    "urlSetSha256",
    "lastmodCount",
    "xmlValid",
    "canonicalSafe",
    "sameOrigin",
  ];
  const mismatchFields = fields.filter((field) => runs[0][field] !== runs[1][field]);
  return { bothRunsMatch: mismatchFields.length === 0, mismatchFields };
}

export async function probeWorldconsSitemap(options: SitemapProbeOptions = {}): Promise<SitemapProbeReport> {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? wait;
  const gapMs = Math.max(0, Math.min(options.gapMs ?? SITEMAP_PROBE_GAP_MS, SITEMAP_PROBE_GAP_MS));
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? SITEMAP_PROBE_TIMEOUT_MS, SITEMAP_PROBE_TIMEOUT_MS));
  const maxBytes = Math.max(
    1,
    Math.min(options.maxResponseBytes ?? SITEMAP_PROBE_MAX_BYTES, SITEMAP_PROBE_MAX_BYTES),
  );

  const results: Array<{ ok: true; run: SitemapProbeRun } | { ok: false; error: SitemapProbeError }> = [];

  for (let run = 1; run <= SITEMAP_PROBE_RUNS; run += 1) {
    try {
      results.push({ ok: true, run: await probeRun(run, fetchImpl, now, timeoutMs, maxBytes) });
    } catch (error) {
      const probeError =
        error instanceof SitemapProbeError
          ? error
          : new SitemapProbeError("network_error", "Sitemap probe failed.", { run });
      results.push({ ok: false, error: probeError });
    }
    if (run < SITEMAP_PROBE_RUNS) await sleep(gapMs);
  }

  const failure = results.find((result) => !result.ok);
  if (failure && !failure.ok) throw failure.error;

  const runs = results.map((result) => {
    if (!result.ok) throw result.error;
    return result.run;
  });
  const comparison = compareRuns(runs);
  if (!comparison.bothRunsMatch) {
    throw new SitemapProbeError("run_mismatch", "The two sitemap responses disagree.", {
      mismatchFields: comparison.mismatchFields,
    });
  }

  return {
    event: "worldcons_seo_sitemap_probe",
    endpoint: SITEMAP_PROBE_URL,
    runs,
    bothRunsMatch: true,
    mismatchFields: [],
  };
}

async function main() {
  if (process.argv.length > 2) {
    throw new SitemapProbeError("network_error", "This probe accepts no arguments; the endpoint is fixed.");
  }
  const report = await probeWorldconsSitemap();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint && import.meta.url === entrypoint) {
  main().catch((error) => {
    const safeError =
      error instanceof SitemapProbeError
        ? { event: "worldcons_seo_sitemap_probe_failed", code: error.code, message: error.message, details: error.details }
        : { event: "worldcons_seo_sitemap_probe_failed", code: "unexpected_error", message: "Sitemap probe failed." };
    process.stderr.write(`${JSON.stringify(safeError)}\n`);
    process.exitCode = 1;
  });
}
