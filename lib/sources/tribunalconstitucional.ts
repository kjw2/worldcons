import { addDiagnosticAttempt } from "@/lib/crawler/diagnostics";
import type { SourceDiscoveryOptions } from "@/lib/crawler/types";
import { runSpainTcSpider, SPAIN_TC_BASE_URL, SPAIN_TC_SOURCE_KEY } from "@/lib/crawlee";
import { normalizeRawArticle } from "@/lib/ingest/normalize";
import type { DiscoveredItem, RawArticle, SourceAdapter } from "@/lib/sources/types";
import { canonicalizeUrl } from "@/lib/utils/canonical-url";

const rawCache = new Map<string, RawArticle>();

function remember(raw?: RawArticle) {
  if (!raw) return;
  rawCache.set(raw.canonicalUrl, raw);
  rawCache.set(canonicalizeUrl(raw.url), raw);
}

function discoveryLimit(options?: SourceDiscoveryOptions) {
  const value = Number(options?.limit ?? process.env.CRAWLEE_DISCOVER_LIMIT_PER_SOURCE ?? process.env.INGEST_LIMIT_PER_SOURCE ?? 20);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 20;
}

function metadataOnlyRaw(item: DiscoveredItem, options?: SourceDiscoveryOptions): RawArticle {
  const strategy = item.metadata?.collection?.strategy ?? "api";
  addDiagnosticAttempt(options?.diagnostics, {
    sourceKey: SPAIN_TC_SOURCE_KEY,
    url: item.url,
    strategy,
    errorCode: "SPAIN_HJ_DETAIL_EMPTY",
    errorMessage: "Spain HJ spider did not return verified JSON, HTML, or document text for this item.",
  });

  return {
    ...item,
    text: [item.title, item.publishedAt, item.url].filter(Boolean).join("\n"),
    metadata: {
      ...item.metadata,
      review: {
        required: true,
        reason: "fallback_parse",
      },
      collection: {
        strategy,
        confidence: "low",
        sourceUrlVerified: false,
        publishable: false,
        sourceTextAvailable: false,
        strictSourceTextAvailable: true,
        reason: "Spain HJ detail fetch failed; official metadata requires human review.",
      },
      diagnostics: [...(item.metadata?.diagnostics ?? []), ...(options?.diagnostics?.attempts ?? [])].slice(-50),
      warning: item.metadata?.warning ?? "Spain HJ detail could not be fetched; review required.",
    },
  };
}

export const tribunalConstitucionalAdapter: SourceAdapter = {
  sourceKey: SPAIN_TC_SOURCE_KEY,
  displayName: "Tribunal Constitucional de España",
  jurisdiction: "Spain",
  baseUrl: SPAIN_TC_BASE_URL,
  defaultLanguage: "es",

  async discover(options) {
    const result = await runSpainTcSpider({
      limit: discoveryLimit(options),
      rangeDays: options?.rangeDays,
      dryRun: options?.dryRun,
      strategy: "api",
      usePlaywright: false,
      diagnostics: options?.diagnostics,
    });
    for (const entry of result.items) remember(entry.raw);
    return result.items.map((entry) => entry.raw ?? entry.item);
  },

  async fetchItem(item: DiscoveredItem, options?: SourceDiscoveryOptions): Promise<RawArticle> {
    const cached = rawCache.get(item.canonicalUrl) ?? rawCache.get(canonicalizeUrl(item.url));
    if (cached) return cached;

    const result = await runSpainTcSpider({
      limit: 1,
      strategy: "api",
      usePlaywright: false,
      diagnostics: options?.diagnostics,
      detailUrls: [item.url],
      detailOnly: true,
    });
    const raw = result.items[0]?.raw;
    remember(raw);
    return raw ?? metadataOnlyRaw(item, options);
  },

  async normalize(raw: RawArticle) {
    return normalizeRawArticle(raw, this);
  },
};

