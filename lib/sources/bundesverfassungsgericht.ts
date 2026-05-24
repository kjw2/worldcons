import { addDiagnosticAttempt } from "@/lib/crawler/diagnostics";
import type { SourceDiscoveryOptions } from "@/lib/crawler/types";
import { BVERFG_BASE_URL, BVERFG_SEED_DECISIONS, runBverfgSpider } from "@/lib/crawlee";
import { upsertSourceUrlCandidates } from "@/lib/db/source-url-candidates";
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
  return Number.isFinite(value) && value > 0 ? value : 20;
}

function metadataOnlyRaw(item: DiscoveredItem, options?: SourceDiscoveryOptions): RawArticle {
  const strategy = item.metadata?.collection?.strategy ?? (options?.strategy && options.strategy !== "auto" ? options.strategy : "cheerio");
  addDiagnosticAttempt(options?.diagnostics, {
    url: item.url,
    strategy,
    errorCode: "CRAWLEE_DETAIL_EMPTY",
    errorMessage: "Crawlee spider did not return a verified body for this item.",
  });

  return {
    ...item,
    text: [item.title, item.publishedAt, item.url].filter(Boolean).join("\n"),
    metadata: {
      ...item.metadata,
      collection: {
        strategy,
        confidence: "low",
        sourceUrlVerified: false,
        diagnosticsId: item.metadata?.collection?.diagnosticsId,
        publishable: false,
        sourceTextAvailable: false,
        reason: "Live discovery or source text fetch failed. Seed URL was stored for later retry.",
      },
      diagnostics: [...(item.metadata?.diagnostics ?? []), ...(options?.diagnostics?.attempts ?? [])].slice(-50),
      warning: item.metadata?.warning ?? "Crawlee could not fetch the full official source text; review required.",
    },
  };
}

export const bundesverfassungsgerichtAdapter: SourceAdapter = {
  sourceKey: "de-bverfg",
  displayName: "Federal Constitutional Court of Germany",
  jurisdiction: "Germany",
  baseUrl: BVERFG_BASE_URL,
  defaultLanguage: "de",

  async discover(options) {
    const result = await runBverfgSpider({
      limit: discoveryLimit(options),
      rangeDays: options?.rangeDays,
      dryRun: options?.dryRun,
      strategy: options?.strategy ?? "auto",
      usePlaywright: options?.usePlaywright,
      diagnostics: options?.diagnostics,
    });
    for (const entry of result.items) remember(entry.raw);
    if (result.items.length === 0 && !options?.rangeDays) {
      const candidateResult = options?.dryRun
        ? { inserted: 0, skipped: BVERFG_SEED_DECISIONS.length }
        : await upsertSourceUrlCandidates(
            BVERFG_SEED_DECISIONS.map((seed) => ({
              sourceKey: "de-bverfg",
              url: seed.url,
              candidateType: "decision",
              discoveredBy: "seed",
              status: "pending",
              lastErrorCode: "BVERFG_LIVE_DISCOVERY_EMPTY",
              lastErrorMessage: "Sitemap-first BVerfG discovery did not return a verified official detail page in this environment.",
            })),
          );
      addDiagnosticAttempt(options?.diagnostics, {
        strategy: "seed",
        discoveredCount: BVERFG_SEED_DECISIONS.length,
        fallback: true,
        result: "error" in candidateResult && candidateResult.error ? "failed" : "success",
        errorCode:
          "error" in candidateResult && candidateResult.error
            ? "SOURCE_URL_CANDIDATE_UPSERT_FAILED"
            : options?.dryRun
              ? "SOURCE_URL_CANDIDATES_DRY_RUN"
              : "SOURCE_URL_CANDIDATES_ONLY",
        errorMessage:
          ("error" in candidateResult ? candidateResult.error : undefined) ??
          (options?.dryRun
            ? "BVerfG seed URLs would be saved as retry candidates; dry-run skipped DB writes."
            : "BVerfG seed URLs were saved as retry candidates only; no seed article rows will be created."),
      });
    }
    return result.items.map((entry) => entry.raw ?? entry.item);
  },

  async fetchItem(item: DiscoveredItem, options?: SourceDiscoveryOptions): Promise<RawArticle> {
    const cached = rawCache.get(item.canonicalUrl) ?? rawCache.get(canonicalizeUrl(item.url));
    if (cached) return cached;

    const result = await runBverfgSpider({
      limit: 1,
      strategy: options?.strategy ?? "auto",
      usePlaywright: options?.usePlaywright,
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
