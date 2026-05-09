import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import { countSelectorMatches } from "@/lib/crawler/extract-links";
import { extractReadableText } from "@/lib/crawler/extract-readable-text";
import { parseRobotsTxt } from "@/lib/crawler/robots";
import { crawlerHeaders } from "@/lib/crawler/user-agents";
import { crawlWithPlaywright, isPlaywrightEnabled } from "@/lib/crawler/playwright-client";
import type { CrawlAttemptLog } from "@/lib/crawler/types";

type TimeoutPhase = NonNullable<CrawlAttemptLog["timeoutPhase"]>;
type ProbeResult = {
  url: string;
  finalUrl?: string;
  result: "success" | "timeout" | "blocked" | "failed";
  timeoutPhase?: TimeoutPhase;
  timeoutMs: number;
  statusCode?: number | null;
  contentType?: string | null;
  redirectChain: string[];
  dnsResolved: boolean;
  tcpConnected: boolean;
  tlsHandshakeCompleted: boolean;
  htmlLength: number;
  textLength: number;
  selectorMatchCount: number;
  errorCode?: string;
  errorMessage?: string;
  bodyText?: string;
};

const BVERFG_SELECTORS = [
  "main",
  "article",
  "#pagemaindiv",
  ".c-detail",
  ".content",
  "#content",
  "body",
];

function timeoutMs() {
  return Math.max(5_000, Number(process.env.BVERFG_TIMEOUT_MS ?? process.env.CRAWLER_TIMEOUT_MS ?? 60_000));
}

function isTextContent(contentType?: string | null) {
  return !contentType || /text|html|xml|json|javascript/i.test(contentType);
}

function baseFailure(url: string, timeout: number): ProbeResult {
  return {
    url,
    result: "failed",
    timeoutMs: timeout,
    statusCode: null,
    contentType: null,
    redirectChain: [],
    dnsResolved: false,
    tcpConnected: false,
    tlsHandshakeCompleted: false,
    htmlLength: 0,
    textLength: 0,
    selectorMatchCount: 0,
  };
}

function hostnameFor(url: string) {
  return new URL(url).hostname;
}

async function resolveForFamily(hostname: string, family?: 4 | 6) {
  return dns.lookup(hostname, { all: true, family });
}

export async function diagnoseDns(hostname: string) {
  const all = await dns.lookup(hostname, { all: true }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  const ipv4 = await resolveForFamily(hostname, 4).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  const ipv6 = await resolveForFamily(hostname, 6).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  return { hostname, all, ipv4, ipv6 };
}

export async function probeTcp(hostname: string, family: 4 | 6, port = 443, timeout = timeoutMs()) {
  const result = { family, result: "failed" as ProbeResult["result"], timeoutMs: timeout, dnsResolved: false, tcpConnected: false, timeoutPhase: undefined as TimeoutPhase | undefined, errorCode: undefined as string | undefined, errorMessage: undefined as string | undefined };
  const addresses = await resolveForFamily(hostname, family).catch((error) => {
    result.timeoutPhase = "dns";
    result.errorCode = error instanceof Error ? error.name : "DNS_ERROR";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    return [];
  });
  if (!Array.isArray(addresses) || addresses.length === 0) return result;
  result.dnsResolved = true;

  return new Promise<typeof result>((resolve) => {
    const socket = net.connect({ host: addresses[0].address, port, family });
    const timer = setTimeout(() => {
      result.result = "timeout";
      result.timeoutPhase = "tcp_connect";
      result.errorCode = "TCP_CONNECT_TIMEOUT";
      result.errorMessage = `TCP connect timed out after ${timeout}ms`;
      socket.destroy();
      resolve(result);
    }, timeout);

    socket.once("connect", () => {
      clearTimeout(timer);
      result.result = "success";
      result.tcpConnected = true;
      socket.end();
      resolve(result);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      result.errorCode = error.name;
      result.errorMessage = error.message;
      socket.destroy();
      resolve(result);
    });
  });
}

export async function probeTls(hostname: string, family: 4 | 6, port = 443, timeout = timeoutMs()) {
  const result = { family, result: "failed" as ProbeResult["result"], timeoutMs: timeout, dnsResolved: false, tcpConnected: false, tlsHandshakeCompleted: false, timeoutPhase: undefined as TimeoutPhase | undefined, errorCode: undefined as string | undefined, errorMessage: undefined as string | undefined };
  const addresses = await resolveForFamily(hostname, family).catch((error) => {
    result.timeoutPhase = "dns";
    result.errorCode = error instanceof Error ? error.name : "DNS_ERROR";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    return [];
  });
  if (!Array.isArray(addresses) || addresses.length === 0) return result;
  result.dnsResolved = true;

  return new Promise<typeof result>((resolve) => {
    const socket = tls.connect({ host: addresses[0].address, port, servername: hostname });
    const timer = setTimeout(() => {
      result.result = "timeout";
      result.timeoutPhase = result.tcpConnected ? "tls_handshake" : "tcp_connect";
      result.errorCode = "TLS_HANDSHAKE_TIMEOUT";
      result.errorMessage = `TLS handshake timed out after ${timeout}ms`;
      socket.destroy();
      resolve(result);
    }, timeout);

    socket.once("connect", () => {
      result.tcpConnected = true;
    });
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      result.result = "success";
      result.tcpConnected = true;
      result.tlsHandshakeCompleted = true;
      socket.end();
      resolve(result);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      result.errorCode = error.name;
      result.errorMessage = error.message;
      socket.destroy();
      resolve(result);
    });
  });
}

export async function probeHttpUrl(url: string, options: { family?: 4 | 6; method?: "GET" | "HEAD"; timeoutMs?: number; maxBytes?: number; redirectChain?: string[] } = {}): Promise<ProbeResult> {
  const timeout = options.timeoutMs ?? timeoutMs();
  const maxBytes = options.maxBytes ?? 1_000_000;
  const parsed = new URL(url);
  const client = parsed.protocol === "http:" ? http : https;
  const result = baseFailure(url, timeout);
  let phase: TimeoutPhase = "dns";

  return new Promise<ProbeResult>((resolve) => {
    const request = client.request(
      parsed,
      {
        method: options.method ?? "GET",
        family: options.family,
        timeout,
        headers: crawlerHeaders(),
      },
      (response) => {
        phase = "body_download";
        result.statusCode = response.statusCode ?? null;
        result.contentType = response.headers["content-type"]?.toString() ?? null;
        result.finalUrl = url;
        result.result = response.statusCode === 403 || response.statusCode === 429 ? "blocked" : response.statusCode && response.statusCode >= 400 ? "failed" : "success";
        result.redirectChain = options.redirectChain ?? [];

        const location = response.headers.location;
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location && result.redirectChain.length < 8) {
          response.resume();
          const nextUrl = new URL(location, url).toString();
          probeHttpUrl(nextUrl, {
            ...options,
            redirectChain: [...result.redirectChain, url],
          }).then((next) => resolve({ ...next, redirectChain: [...result.redirectChain, url, ...next.redirectChain.filter((item) => item !== url)] }));
          return;
        }

        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length <= maxBytes) chunks.push(chunk);
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          result.htmlLength = isTextContent(result.contentType) ? body.length : 0;
          result.bodyText = isTextContent(result.contentType) ? body : undefined;
          result.textLength = result.bodyText ? extractReadableText(result.bodyText, result.finalUrl ?? url, BVERFG_SELECTORS).trim().length : 0;
          result.selectorMatchCount = result.bodyText ? countSelectorMatches(result.bodyText, BVERFG_SELECTORS).reduce((sum, item) => sum + item.count, 0) : 0;
          resolve(result);
        });
      },
    );

    request.on("socket", (socket) => {
      socket.on("lookup", () => {
        result.dnsResolved = true;
        phase = "tcp_connect";
      });
      socket.on("connect", () => {
        result.tcpConnected = true;
        phase = parsed.protocol === "https:" ? "tls_handshake" : "response_header";
      });
      socket.on("secureConnect", () => {
        result.tlsHandshakeCompleted = true;
        phase = "response_header";
      });
    });
    request.on("timeout", () => {
      request.destroy(Object.assign(new Error(`${phase} timeout after ${timeout}ms`), { code: "TIMEOUT", timeoutPhase: phase }));
    });
    request.on("error", (error: NodeJS.ErrnoException & { timeoutPhase?: TimeoutPhase }) => {
      result.result = error.code === "TIMEOUT" ? "timeout" : "failed";
      result.timeoutPhase = error.timeoutPhase ?? (error.code === "ENOTFOUND" ? "dns" : phase);
      result.errorCode = error.code ?? error.name;
      result.errorMessage = error.message;
      resolve(result);
    });
    request.end();
  });
}

function locsFromXml(xml: string) {
  return Array.from(xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)).map((match) => match[1].trim());
}

function isBverfgDecisionUrl(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.includes("bundesverfassungsgericht") &&
      /\/SharedDocs\/Entscheidungen\/(?:DE|EN)\//i.test(parsed.pathname) &&
      /\.(html|pdf)$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function recommendedAction(report: {
  ipv4: ProbeResult;
  ipv6: ProbeResult;
  tlsIpv4: Awaited<ReturnType<typeof probeTls>>;
  robots: ProbeResult;
  sitemap: ProbeResult;
  detail?: ProbeResult;
  playwright?: ProbeResult | null;
}) {
  if (report.ipv4.result === "success" && report.ipv6.result !== "success") return "Use IPv4 first and keep BVerfG worker maxConcurrency=1.";
  if (report.ipv4.timeoutPhase === "tcp_connect") return "Current network cannot establish TCP to BVerfG; run worker from Cloud Run EU, Fly.io EU, Apify Actor, or German VPS.";
  if (report.tlsIpv4.tcpConnected && !report.tlsIpv4.tlsHandshakeCompleted) return "TCP connects but TLS does not complete; test TLS from an EU worker and inspect SNI/cipher policy.";
  if (report.robots.result === "timeout") return "robots.txt times out before crawl policy can be checked; move crawler to EU network or retry with longer timeout.";
  if (report.sitemap.result === "success" && !report.detail) return "Sitemap is reachable; tune Entscheidung URL filtering and fetch detail pages directly.";
  if (report.detail?.result === "success" && report.detail.textLength < 1000) return "Detail fetch succeeds but extraction is short; inspect selectors/readability.";
  if (report.playwright?.result === "timeout") return "Playwright navigation also times out; network path is the likely blocker, not selector parsing.";
  return "Keep sitemap-first strategy and inspect redirect/selector diagnostics.";
}

export async function diagnoseBverfgNetwork(options: { detailUrl?: string; includePlaywright?: boolean } = {}) {
  const baseUrl = "https://www.bundesverfassungsgericht.de";
  const robotsUrl = `${baseUrl}/robots.txt`;
  const sitemapUrl = `${baseUrl}/sitemap.xml`;
  const hostname = hostnameFor(baseUrl);
  const timeout = timeoutMs();

  const dnsResult = await diagnoseDns(hostname);
  const [ipv4, ipv6, tcpIpv4, tcpIpv6, tlsIpv4, tlsIpv6] = await Promise.all([
    probeHttpUrl(baseUrl, { family: 4, method: "HEAD", timeoutMs: Math.min(timeout, 30_000) }),
    probeHttpUrl(baseUrl, { family: 6, method: "HEAD", timeoutMs: Math.min(timeout, 30_000) }),
    probeTcp(hostname, 4, 443, Math.min(timeout, 30_000)),
    probeTcp(hostname, 6, 443, Math.min(timeout, 30_000)),
    probeTls(hostname, 4, 443, Math.min(timeout, 30_000)),
    probeTls(hostname, 6, 443, Math.min(timeout, 30_000)),
  ]);

  const robots = await probeHttpUrl(robotsUrl, { family: 4, method: "GET", timeoutMs: timeout, maxBytes: 200_000 });
  const robotsParsed = robots.bodyText ? parseRobotsTxt(robots.bodyText, sitemapUrl) : null;
  const sitemap = await probeHttpUrl(sitemapUrl, { family: 4, method: "GET", timeoutMs: timeout, maxBytes: 2_000_000 });
  const sitemapDecisionUrls = sitemap.bodyText ? locsFromXml(sitemap.bodyText).filter(isBverfgDecisionUrl).slice(0, 20) : [];
  const detailUrl = options.detailUrl ?? sitemapDecisionUrls[0];
  const detail = detailUrl ? await probeHttpUrl(detailUrl, { family: 4, method: "GET", timeoutMs: timeout, maxBytes: 2_000_000 }) : undefined;

  let playwright: ProbeResult | null = null;
  if (options.includePlaywright !== false && isPlaywrightEnabled()) {
    const targetUrl = detailUrl ?? sitemapUrl;
    const response = await crawlWithPlaywright({ url: targetUrl, usePlaywright: true, waitUntil: "domcontentloaded" });
    playwright = {
      ...baseFailure(targetUrl, timeout),
      finalUrl: response.finalUrl,
      result: response.status > 0 && response.status < 400 ? "success" : response.diagnostics?.timeout ? "timeout" : response.status === 403 ? "blocked" : "failed",
      timeoutPhase: response.diagnostics?.timeout ? "playwright_navigation" : undefined,
      statusCode: response.status,
      contentType: response.contentType,
      dnsResolved: response.status > 0,
      tcpConnected: response.status > 0,
      tlsHandshakeCompleted: response.status > 0,
      htmlLength: response.html?.length ?? 0,
      textLength: response.html ? extractReadableText(response.html, response.finalUrl, BVERFG_SELECTORS).trim().length : 0,
      selectorMatchCount: response.html ? countSelectorMatches(response.html, BVERFG_SELECTORS).reduce((sum, item) => sum + item.count, 0) : 0,
      errorCode: response.diagnostics?.errorCode,
      errorMessage: response.diagnostics?.errorMessage,
    };
  }

  const summary = {
    dns: Array.isArray(dnsResult.all) ? "resolved" : "failed",
    ipv4: ipv4.result === "success" ? "success" : `${ipv4.result}:${ipv4.timeoutPhase ?? ipv4.errorCode ?? "unknown"}`,
    ipv6: ipv6.result === "success" ? "success" : `${ipv6.result}:${ipv6.timeoutPhase ?? ipv6.errorCode ?? "unknown"}`,
    tls: tlsIpv4.result === "success" ? "success" : `${tlsIpv4.result}:${tlsIpv4.timeoutPhase ?? tlsIpv4.errorCode ?? "unknown"}`,
    robots: robots.result === "success" ? `success:${robots.statusCode}` : `${robots.result}:${robots.timeoutPhase ?? robots.errorCode ?? "unknown"}`,
    sitemap: sitemap.result === "success" ? `success:${sitemapDecisionUrls.length} decision urls` : `${sitemap.result}:${sitemap.timeoutPhase ?? sitemap.errorCode ?? "unknown"}`,
    detailFetch: detail ? (detail.result === "success" ? `success:${detail.textLength} chars` : `${detail.result}:${detail.timeoutPhase ?? detail.errorCode ?? "unknown"}`) : "not-run:no sitemap detail url",
    playwright: playwright ? (playwright.result === "success" ? `success:${playwright.textLength} chars` : `${playwright.result}:${playwright.timeoutPhase ?? playwright.errorCode ?? "unknown"}`) : "skipped",
  };
  const action = recommendedAction({ ipv4, ipv6, tlsIpv4, robots, sitemap, detail, playwright });

  const attempts: CrawlAttemptLog[] = [
    {
      sourceKey: "de-bverfg",
      url: baseUrl,
      strategy: "fetch",
      result: ipv4.result,
      status: ipv4.statusCode ?? undefined,
      statusCode: ipv4.statusCode,
      timeout: ipv4.result === "timeout",
      timeoutPhase: ipv4.timeoutPhase,
      timeoutMs: ipv4.timeoutMs,
      finalUrl: ipv4.finalUrl,
      redirectChain: ipv4.redirectChain,
      dnsResolved: ipv4.dnsResolved,
      tcpConnected: ipv4.tcpConnected,
      tlsHandshakeCompleted: ipv4.tlsHandshakeCompleted,
      htmlLength: ipv4.htmlLength,
      textLength: ipv4.textLength,
      selectorMatchCount: ipv4.selectorMatchCount,
      recommendedAction: action,
      errorCode: ipv4.errorCode,
      errorMessage: ipv4.errorMessage,
    },
    {
      sourceKey: "de-bverfg",
      url: robotsUrl,
      strategy: "robots",
      result: robots.result,
      status: robots.statusCode ?? undefined,
      statusCode: robots.statusCode,
      timeout: robots.result === "timeout",
      timeoutPhase: robots.timeoutPhase,
      timeoutMs: robots.timeoutMs,
      finalUrl: robots.finalUrl,
      dnsResolved: robots.dnsResolved,
      tcpConnected: robots.tcpConnected,
      tlsHandshakeCompleted: robots.tlsHandshakeCompleted,
      robotsAllowed: robotsParsed?.allowed,
      robotsMatchedRule: robotsParsed?.matchedRule,
      robotsMatchedDirective: robotsParsed?.matchedDirective,
      robotsCrawlDelaySeconds: robotsParsed?.crawlDelaySeconds,
      htmlLength: robots.htmlLength,
      textLength: robots.textLength,
      recommendedAction: action,
      errorCode: robots.errorCode,
      errorMessage: robots.errorMessage,
    },
    {
      sourceKey: "de-bverfg",
      url: sitemapUrl,
      strategy: "sitemap",
      result: sitemap.result,
      status: sitemap.statusCode ?? undefined,
      statusCode: sitemap.statusCode,
      timeout: sitemap.result === "timeout",
      timeoutPhase: sitemap.timeoutPhase,
      timeoutMs: sitemap.timeoutMs,
      finalUrl: sitemap.finalUrl,
      discoveredCount: sitemapDecisionUrls.length,
      dnsResolved: sitemap.dnsResolved,
      tcpConnected: sitemap.tcpConnected,
      tlsHandshakeCompleted: sitemap.tlsHandshakeCompleted,
      htmlLength: sitemap.htmlLength,
      textLength: sitemap.textLength,
      selectorMatchCount: sitemap.selectorMatchCount,
      recommendedAction: action,
      errorCode: sitemap.errorCode,
      errorMessage: sitemap.errorMessage,
    },
  ];

  if (detail) {
    attempts.push({
      sourceKey: "de-bverfg",
      url: detail.url,
      strategy: "fetch",
      result: detail.result,
      status: detail.statusCode ?? undefined,
      statusCode: detail.statusCode,
      timeout: detail.result === "timeout",
      timeoutPhase: detail.timeoutPhase,
      timeoutMs: detail.timeoutMs,
      finalUrl: detail.finalUrl,
      redirectChain: detail.redirectChain,
      dnsResolved: detail.dnsResolved,
      tcpConnected: detail.tcpConnected,
      tlsHandshakeCompleted: detail.tlsHandshakeCompleted,
      htmlLength: detail.htmlLength,
      textLength: detail.textLength,
      selectorMatchCount: detail.selectorMatchCount,
      recommendedAction: action,
      errorCode: detail.errorCode,
      errorMessage: detail.errorMessage,
    });
  }

  if (playwright) {
    attempts.push({
      sourceKey: "de-bverfg",
      url: playwright.url,
      strategy: "playwright",
      result: playwright.result,
      status: playwright.statusCode ?? undefined,
      statusCode: playwright.statusCode,
      timeout: playwright.result === "timeout",
      timeoutPhase: playwright.timeoutPhase,
      timeoutMs: playwright.timeoutMs,
      finalUrl: playwright.finalUrl,
      htmlLength: playwright.htmlLength,
      textLength: playwright.textLength,
      selectorMatchCount: playwright.selectorMatchCount,
      recommendedAction: action,
      errorCode: playwright.errorCode,
      errorMessage: playwright.errorMessage,
    });
  }

  return {
    sourceKey: "de-bverfg",
    url: baseUrl,
    timeoutMs: timeout,
    diagnostics: {
      dns: dnsResult,
      tcp: { ipv4: tcpIpv4, ipv6: tcpIpv6 },
      tls: { ipv4: tlsIpv4, ipv6: tlsIpv6 },
      ipv4Fetch: ipv4,
      ipv6Fetch: ipv6,
      robots: { ...robots, bodyText: undefined, parsed: robotsParsed },
      sitemap: { ...sitemap, bodyText: undefined, decisionUrlCount: sitemapDecisionUrls.length, sampleDecisionUrls: sitemapDecisionUrls.slice(0, 5) },
      detailFetch: detail ? { ...detail, bodyText: undefined } : null,
      playwright,
      attempts,
    },
    environmentComparison: [
      {
        Environment: "local",
        DNS: summary.dns,
        IPv4: summary.ipv4,
        IPv6: summary.ipv6,
        TLS: summary.tls,
        robots: summary.robots,
        sitemap: summary.sitemap,
        "detail fetch": summary.detailFetch,
        Playwright: summary.playwright,
        Result: detail?.result === "success" && detail.textLength >= 1000 ? "official body fetched" : "not publishable in this environment",
        "Recommended Action": action,
      },
      {
        Environment: "GitHub Actions",
        DNS: "not executed",
        IPv4: "not executed",
        IPv6: "not executed",
        TLS: "not executed",
        robots: "not executed",
        sitemap: "not executed",
        "detail fetch": "not executed",
        Playwright: "not executed",
        Result: "pending external run",
        "Recommended Action": "Run pnpm crawler:diagnose -- --source=de-bverfg --debug in workflow.",
      },
      {
        Environment: "Vercel",
        DNS: "not executed",
        IPv4: "not executed",
        IPv6: "not executed",
        TLS: "not executed",
        robots: "not executed",
        sitemap: "not executed",
        "detail fetch": "not executed",
        Playwright: "not executed",
        Result: "not recommended for heavy crawling",
        "Recommended Action": "Keep Vercel for UI/API only.",
      },
      {
        Environment: "Cloud Run EU",
        DNS: "not executed",
        IPv4: "not executed",
        IPv6: "not executed",
        TLS: "not executed",
        robots: "not executed",
        sitemap: "not executed",
        "detail fetch": "not executed",
        Playwright: "not executed",
        Result: "pending external run",
        "Recommended Action": "Prefer europe-west3/europe-west1 if local TCP connect times out.",
      },
      {
        Environment: "Apify Actor",
        DNS: "not executed",
        IPv4: "not executed",
        IPv6: "not executed",
        TLS: "not executed",
        robots: "not executed",
        sitemap: "not executed",
        "detail fetch": "not executed",
        Playwright: "not executed",
        Result: "pending external run",
        "Recommended Action": "Use if EU Cloud Run/Fly is unavailable.",
      },
    ],
    summary: {
      ...summary,
      timeoutPhase: ipv4.timeoutPhase ?? robots.timeoutPhase ?? sitemap.timeoutPhase ?? detail?.timeoutPhase ?? playwright?.timeoutPhase,
      recommendedAction: action,
    },
  };
}
