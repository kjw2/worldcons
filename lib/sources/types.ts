import type { ArticleContentType } from "@/lib/db/types";
import type { CollectionMetadata, CrawlAttemptLog, SourceDiscoveryOptions } from "@/lib/crawler/types";

export interface DiscoveredItem {
  sourceKey: string;
  url: string;
  canonicalUrl: string;
  title?: string;
  publishedAt?: string;
  contentType: ArticleContentType;
  metadata?: Record<string, unknown> & {
    collection?: CollectionMetadata;
    diagnostics?: CrawlAttemptLog[];
    bodySelectors?: string[];
  };
}

export interface RawArticle {
  sourceKey: string;
  url: string;
  canonicalUrl: string;
  title?: string;
  publishedAt?: string;
  contentType: ArticleContentType;
  html?: string;
  text?: string;
  pdfBuffer?: Buffer;
  metadata?: Record<string, unknown> & {
    collection?: CollectionMetadata;
    diagnostics?: CrawlAttemptLog[];
    bodySelectors?: string[];
  };
}

export interface NormalizedArticle {
  sourceKey: string;
  jurisdiction: string;
  institutionName: string;
  contentType: ArticleContentType;
  originalUrl: string;
  canonicalUrl: string;
  originalLanguage: string;
  originalTitle?: string;
  originalPublishedAt?: string;
  rawText?: string;
  cleanedText?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceAdapter {
  sourceKey: string;
  displayName: string;
  jurisdiction: string;
  baseUrl: string;
  defaultLanguage: string;

  discover(options?: SourceDiscoveryOptions): Promise<DiscoveredItem[]>;
  fetchItem(item: DiscoveredItem, options?: SourceDiscoveryOptions): Promise<RawArticle>;
  normalize(raw: RawArticle): Promise<NormalizedArticle>;
}
