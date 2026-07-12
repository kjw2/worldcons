export type CrawlStrategy =
  | "official-listing"
  | "fetch"
  | "cheerio"
  | "playwright"
  | "rss"
  | "api"
  | "sitemap"
  | "sitemap-detail"
  | "seed";
export type CrawlStrategyOption = CrawlStrategy | "auto";

export interface CrawlRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  timeoutMs?: number;
  rateLimitDelayMs?: number;
  usePlaywright?: boolean;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  waitForSelector?: string;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
}

export interface CrawlDiagnostics {
  redirected?: boolean;
  redirectChain?: string[];
  blocked?: boolean;
  timeout?: boolean;
  timeoutPhase?:
    | "dns"
    | "tcp_connect"
    | "tls_handshake"
    | "response_header"
    | "body_download"
    | "redirect"
    | "playwright_navigation"
    | "selector_wait"
    | "text_extraction";
  selectorMatched?: boolean;
  selectorMatchCount?: number;
  title?: string;
  description?: string | null;
  errorCode?: string;
  errorMessage?: string;
}

export interface CrawlResponse {
  url: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  html?: string;
  text?: string;
  buffer?: Buffer;
  headers: Record<string, string>;
  fetchedAt: string;
  strategy: CrawlStrategy;
  diagnostics?: CrawlDiagnostics;
}

export interface CrawlAttemptLog {
  sourceKey?: string;
  url?: string;
  finalUrl?: string;
  strategy: CrawlStrategy | CrawlStrategyOption | "robots";
  status?: number;
  contentType?: string;
  robotsUrl?: string;
  robotsAllowed?: boolean;
  robotsMatchedRule?: string;
  robotsMatchedDirective?: "allow" | "disallow";
  robotsCrawlDelaySeconds?: number;
  robotsUserAgent?: string;
  maxConcurrency?: number;
  selectorMatched?: boolean;
  selectorMatchCount?: number;
  discoveredCount?: number;
  fallback?: boolean;
  blocked?: boolean;
  timeout?: boolean;
  timeoutPhase?:
    | "dns"
    | "tcp_connect"
    | "tls_handshake"
    | "response_header"
    | "body_download"
    | "redirect"
    | "playwright_navigation"
    | "selector_wait"
    | "text_extraction";
  timeoutMs?: number;
  result?: "success" | "timeout" | "blocked" | "failed";
  statusCode?: number | null;
  redirectChain?: string[];
  dnsResolved?: boolean;
  tcpConnected?: boolean;
  tlsHandshakeCompleted?: boolean;
  textLength?: number;
  recommendedAction?: string;
  errorCode?: string;
  errorMessage?: string;
  title?: string;
  htmlLength?: number;
}

export interface CrawlerDiagnosticsCollector {
  sourceKey?: string;
  attempts: CrawlAttemptLog[];
}

export interface SourceDiscoveryOptions {
  debug?: boolean;
  dryRun?: boolean;
  limit?: number;
  rangeDays?: number;
  strategy?: CrawlStrategyOption;
  usePlaywright?: boolean;
  diagnostics?: CrawlerDiagnosticsCollector;
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
}

export type CollectionConfidence = "high" | "medium" | "low";

export interface CollectionMetadata {
  strategy: CrawlStrategy;
  confidence: CollectionConfidence;
  diagnosticsId?: string;
  sourceUrlVerified: boolean;
  publishable?: boolean;
  sourceTextAvailable?: boolean;
  strictSourceTextAvailable?: boolean;
  sourceTextPolicy?: "strict";
  robotsDisallowed?: boolean;
  reason?: string;
  source?: string;
}
