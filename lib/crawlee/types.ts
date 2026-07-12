import type {
  CollectionConfidence,
  CrawlStrategy,
  CrawlStrategyOption,
  CrawlerDiagnosticsCollector,
  CrawlerExecutionHooks,
} from "@/lib/crawler/types";
import type { HtmlMetadata } from "@/lib/crawler/extract-metadata";
import type { DiscoveredItem, RawArticle } from "@/lib/sources/types";

export type CrawleeRequestLabel = "LIST" | "DETAIL";

export interface CrawleeSeedItem {
  url: string;
  title: string;
  publishedAt?: string;
}

export interface CrawleeSpiderOptions extends CrawlerExecutionHooks {
  limit?: number;
  rangeDays?: number;
  dryRun?: boolean;
  strategy?: CrawlStrategyOption;
  usePlaywright?: boolean;
  diagnostics?: CrawlerDiagnosticsCollector;
  detailUrls?: string[];
  detailItems?: DiscoveredItem[];
  detailOnly?: boolean;
}

export interface CrawleeSpiderItem {
  item: DiscoveredItem;
  raw?: RawArticle;
}

export interface CrawleeSpiderResult {
  sourceKey: string;
  items: CrawleeSpiderItem[];
  diagnostics: CrawlerDiagnosticsCollector;
  strategySequence: CrawlStrategy[];
  usedSeedFallback: boolean;
}

export interface CrawleeStartRequest {
  url: string;
  label: CrawleeRequestLabel;
  item?: DiscoveredItem;
  collectionStrategy: CrawlStrategy;
  fallback?: boolean;
  listingUrl?: string;
}

export interface OfficialSpiderConfig {
  sourceKey: string;
  baseUrl: string;
  sitemapBaseUrls: string[];
  listUrls: string[];
  listSelectors: string[];
  bodySelectors: string[];
  sitemapKeywords: string[];
  seedItems: CrawleeSeedItem[];
  preferSitemap?: boolean;
  disableSeedArticleFallback?: boolean;
  itemFromUrl: (url: string, strategy: CrawlStrategy, metadata?: Record<string, unknown>) => DiscoveredItem;
  isCandidateUrl: (url: string, title?: string) => boolean;
  sortItems?: (items: CrawleeSpiderItem[]) => CrawleeSpiderItem[];
  confidenceFor?: (strategy: CrawlStrategy, textLength: number, sourceUrlVerified: boolean) => CollectionConfidence;
  publishedAtForHtml?: (metadata: HtmlMetadata, item: DiscoveredItem, finalUrl: string) => string | undefined;
}
