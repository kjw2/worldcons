import { getSupabaseAdmin } from "@/lib/db/client";
import type { SummaryJson } from "@/lib/db/types";
import { createDiagnosticsCollector } from "@/lib/crawler/diagnostics";
import type { CrawlStrategyOption, CrawlerDiagnosticsCollector } from "@/lib/crawler/types";
import { createContentHash } from "@/lib/utils/hash";
import { generateArticleSlug } from "@/lib/utils/slug";
import { sourceAdapters } from "@/lib/sources";
import { isConstitutionallyRelevant } from "@/lib/sources/relevance";
import type { NormalizedArticle, SourceAdapter } from "@/lib/sources/types";
import { dedupKeysForArticle, uniqueDiscoveredItems } from "@/lib/ingest/dedup";
import { canSummarizeArticle, deriveCollectionStatus, finalizeCollectionMetadata } from "@/lib/ingest/publishability";
import { summarizeArticle } from "@/lib/ai/summarize";
import { createEmbedding } from "@/lib/ai/embeddings";
import { normalizeTagForStorage } from "@/lib/ai/tags";

interface SourceRunResult {
  sourceKey: string;
  discoveredCount: number;
  fetchedCount: number;
  summarizedCount: number;
  failedCount: number;
  skippedCount: number;
  errors: string[];
  diagnostics?: CrawlerDiagnosticsCollector;
  statusCounts: Record<string, number>;
  collectionCounts: {
    publishableCount: number;
    metadataOnlyCount: number;
    robotsDisallowedCount: number;
    blockedCount: number;
    timeoutCount: number;
    seedCount: number;
  };
}

interface RunIngestOptions {
  sourceKey?: string;
  limit?: number;
  debug?: boolean;
  strategy?: CrawlStrategyOption;
  usePlaywright?: boolean;
}

function inlineCrawlerBlockReason() {
  if (process.env.VERCEL !== "1") return null;
  if (process.env.CRAWLEE_WORKER === "true") return null;
  if (process.env.ENABLE_VERCEL_CRAWLING === "true") return null;
  return "Inline crawling is disabled on Vercel. Run pnpm crawl:worker in GitHub Actions, Cloud Run, Apify Actor, or another worker runtime.";
}

async function createIngestionRun(sourceKey: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("ingestion_runs")
    .insert({ source_key: sourceKey, status: "running" })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return String(data.id);
}

async function closeIngestionRun(runId: string | null, result: SourceRunResult, status = "completed") {
  const supabase = getSupabaseAdmin();
  if (!supabase || !runId) return;

  await supabase
    .from("ingestion_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      discovered_count: result.discoveredCount,
      fetched_count: result.fetchedCount,
      summarized_count: result.summarizedCount,
      failed_count: result.failedCount,
      error_message: result.errors[0] ?? null,
      metadata: {
        skippedCount: result.skippedCount,
        errors: result.errors.slice(0, 10),
        diagnostics: result.diagnostics,
        fallbackUsed: Boolean(result.diagnostics?.attempts.some((attempt) => attempt.fallback || attempt.strategy === "seed")),
        statusCounts: result.statusCounts,
        collectionCounts: result.collectionCounts,
      },
    })
    .eq("id", runId);
}

async function findSourceId(sourceKey: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data } = await supabase.from("sources").select("id").eq("source_key", sourceKey).maybeSingle();
  return data?.id ?? null;
}

async function articleExists(canonicalUrl: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;

  const { data } = await supabase.from("articles").select("id").eq("canonical_url", canonicalUrl).maybeSingle();
  return Boolean(data);
}

async function articleExistsByNormalizedContent(article: NormalizedArticle) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;

  const contentHash = createContentHash(article.cleanedText);
  if (contentHash) {
    const { data, error } = await supabase.from("articles").select("id").eq("source_key", article.sourceKey).eq("content_hash", contentHash).maybeSingle();
    if (!error && data) return true;
  }

  if (article.originalTitle && article.originalPublishedAt) {
    const { data } = await supabase
      .from("articles")
      .select("id")
      .eq("source_key", article.sourceKey)
      .eq("original_title", article.originalTitle)
      .eq("original_published_at", article.originalPublishedAt)
      .maybeSingle();
    return Boolean(data);
  }

  return false;
}

async function insertNormalizedArticle(article: NormalizedArticle, diagnosticsId?: string | null) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const sourceId = await findSourceId(article.sourceKey);
  const constitutionalRelevant = article.sourceKey !== "us-scotus" || isConstitutionallyRelevant(article);
  const collection = finalizeCollectionMetadata(article, diagnosticsId, constitutionalRelevant);
  let status = deriveCollectionStatus({
    ...article,
    metadata: {
      ...article.metadata,
      collection,
    },
  });
  if (status === "cleaned" && article.sourceKey === "us-scotus" && !constitutionalRelevant) {
    status = "needs_review";
    collection.publishable = false;
    collection.reason = collection.reason ?? "SCOTUS item was not automatically classified as constitutionally relevant.";
  }
  const slug = generateArticleSlug(article);
  const dedupKeys = dedupKeysForArticle(article);

  const { data, error } = await supabase
    .from("articles")
    .insert({
      source_id: sourceId,
      source_key: article.sourceKey,
      jurisdiction: article.jurisdiction,
      institution_name: article.institutionName,
      content_type: article.contentType,
      original_url: article.originalUrl,
      canonical_url: article.canonicalUrl,
      original_language: article.originalLanguage,
      original_title: article.originalTitle,
      original_published_at: article.originalPublishedAt,
      fetched_at: new Date().toISOString(),
      status,
      slug,
      raw_text: article.rawText,
      cleaned_text: article.cleanedText,
      content_hash: createContentHash(article.cleanedText) ?? dedupKeys.textPrefixHash,
      source_metadata: {
        ...article.metadata,
        collection,
        dedupKeys,
        constitutionalKeywordRelevant: article.sourceKey === "us-scotus" ? isConstitutionallyRelevant(article) : undefined,
      },
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return { id: String(data.id), status, collection };
}

async function runSingleSource(adapter: SourceAdapter, limit: number, options: RunIngestOptions = {}): Promise<SourceRunResult> {
  const result: SourceRunResult = {
    sourceKey: adapter.sourceKey,
    discoveredCount: 0,
    fetchedCount: 0,
    summarizedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    errors: [],
    diagnostics: createDiagnosticsCollector(adapter.sourceKey),
    statusCounts: {},
    collectionCounts: {
      publishableCount: 0,
      metadataOnlyCount: 0,
      robotsDisallowedCount: 0,
      blockedCount: 0,
      timeoutCount: 0,
      seedCount: 0,
    },
  };
  const runId = await createIngestionRun(adapter.sourceKey);
  const discoveryOptions = {
    debug: options.debug,
    limit,
    strategy: options.strategy ?? "auto",
    usePlaywright: options.usePlaywright,
    diagnostics: result.diagnostics,
  };

  try {
    const discovered = uniqueDiscoveredItems(await adapter.discover(discoveryOptions)).slice(0, limit);
    result.discoveredCount = discovered.length;

    for (const item of discovered) {
      try {
        if (await articleExists(item.canonicalUrl)) {
          result.skippedCount += 1;
          continue;
        }

        const raw = await adapter.fetchItem(item, discoveryOptions);
        const normalized = await adapter.normalize(raw);
        if (await articleExistsByNormalizedContent(normalized)) {
          result.skippedCount += 1;
          continue;
        }
        const inserted = await insertNormalizedArticle(normalized, runId);
        if (inserted) {
          result.statusCounts[inserted.status] = (result.statusCounts[inserted.status] ?? 0) + 1;
          if (inserted.collection.publishable) result.collectionCounts.publishableCount += 1;
          if (!inserted.collection.sourceTextAvailable) result.collectionCounts.metadataOnlyCount += 1;
          if (inserted.collection.robotsDisallowed) result.collectionCounts.robotsDisallowedCount += 1;
          if (inserted.status === "blocked") result.collectionCounts.blockedCount += 1;
          if (inserted.status === "timeout") result.collectionCounts.timeoutCount += 1;
          if (inserted.collection.strategy === "seed") result.collectionCounts.seedCount += 1;
        }
        result.fetchedCount += 1;
      } catch (error) {
        result.failedCount += 1;
        result.errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    await closeIngestionRun(runId, result);
    return result;
  } catch (error) {
    result.failedCount += 1;
    result.errors.push(error instanceof Error ? error.message : String(error));
    await closeIngestionRun(runId, result, "failed");
    return result;
  }
}

export async function runIngest(options: RunIngestOptions = {}) {
  const limit = options.limit ?? Number(process.env.INGEST_LIMIT_PER_SOURCE ?? 20);
  const blocked = inlineCrawlerBlockReason();
  if (blocked) {
    return {
      mode: "blocked",
      message: blocked,
      results: [],
    };
  }

  const activeSourceKeys = await getActiveSourceKeys();
  const selectedAdapters = sourceAdapters.filter(
    (adapter) => (!options.sourceKey || adapter.sourceKey === options.sourceKey) && (!activeSourceKeys || activeSourceKeys.has(adapter.sourceKey)),
  );

  if (!getSupabaseAdmin()) {
    const discovered = await Promise.allSettled(
      selectedAdapters.map((adapter) => {
        const diagnostics = createDiagnosticsCollector(adapter.sourceKey);
        return adapter.discover({
          debug: options.debug,
          limit,
          strategy: options.strategy ?? "auto",
          usePlaywright: options.usePlaywright,
          diagnostics,
        }).then((items) => ({ items, diagnostics }));
      }),
    );
    return {
      mode: "no-database",
      results: discovered.map((result, index) => ({
        sourceKey: selectedAdapters[index]?.sourceKey ?? "unknown",
        discoveredCount: result.status === "fulfilled" ? result.value.items.slice(0, limit).length : 0,
        fetchedCount: 0,
        summarizedCount: 0,
        failedCount: result.status === "rejected" ? 1 : 0,
        skippedCount: 0,
        errors: result.status === "rejected" ? [String(result.reason)] : [],
        diagnostics: result.status === "fulfilled" ? result.value.diagnostics : undefined,
        statusCounts: {},
        collectionCounts: {
          publishableCount: 0,
          metadataOnlyCount: 0,
          robotsDisallowedCount: 0,
          blockedCount: 0,
          timeoutCount: 0,
          seedCount: 0,
        },
      })),
    };
  }

  const results: SourceRunResult[] = [];
  for (const adapter of selectedAdapters) {
    results.push(await runSingleSource(adapter, limit, options));
  }

  return { mode: "database", results };
}

async function getActiveSourceKeys() {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase.from("sources").select("source_key").eq("is_active", true);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((source) => String(source.source_key)));
}

async function upsertSummaryTags(articleId: string, summary: SummaryJson, originalPublishedAt?: string | null) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  const tagInputs = [
    ...summary.entities.map((entity) => ({
      name: entity.name,
      normalizedName: entity.normalizedName,
      type: entity.type,
    })),
    ...summary.tags.map((tag) => ({
      name: tag,
      normalizedName: tag,
      type: "topic" as const,
    })),
  ];

  for (const input of tagInputs) {
    const normalized = normalizeTagForStorage(input.name, input.normalizedName, input.type);
    const { data: tag, error } = await supabase
      .from("tags")
      .upsert(
        {
          slug: normalized.slug,
          name: normalized.name,
          normalized_name: normalized.normalizedName,
          type: normalized.type,
          latest_article_at: originalPublishedAt,
        },
        { onConflict: "slug" },
      )
      .select("id")
      .single();

    if (error) throw new Error(error.message);
    await supabase.from("article_tags").upsert(
      {
        article_id: articleId,
        tag_id: tag.id,
        confidence: 0.8,
      },
      { onConflict: "article_id,tag_id" },
    );
  }

  await supabase.rpc("refresh_tag_counts");
}

export async function runSummarizePending(options: { limit?: number } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return {
      mode: "no-database",
      summarizedCount: 0,
      failedCount: 0,
      message: "Supabase 환경변수가 없어 DB 요약 작업을 건너뜁니다. UI는 mock summary로 확인할 수 있습니다.",
    };
  }

  const limit = options.limit ?? 10;
  const { data, error } = await supabase
    .from("articles")
    .select(
      "id, source_key, jurisdiction, institution_name, content_type, original_url, canonical_url, original_language, original_title, original_published_at, cleaned_text, status, source_metadata",
    )
    .in("status", ["cleaned", "failed_summary"])
    .is("summarized_at", null)
    .limit(Math.max(limit * 3, limit));

  if (error) throw new Error(error.message);

  let summarizedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const row of data ?? []) {
    if (summarizedCount >= limit) break;
    if (!canSummarizeArticle(row)) {
      skippedCount += 1;
      continue;
    }
    await supabase.from("articles").update({ status: "summarizing" }).eq("id", row.id);
    try {
      const summary = await summarizeArticle({
        sourceKey: row.source_key,
        jurisdiction: row.jurisdiction,
        institutionName: row.institution_name,
        contentType: row.content_type,
        originalUrl: row.original_url,
        canonicalUrl: row.canonical_url,
        originalLanguage: row.original_language,
        originalTitle: row.original_title,
        originalPublishedAt: row.original_published_at,
        cleanedText: row.cleaned_text,
      });
      const embedding = await createEmbedding(summary).catch(() => null);
      const updatePayload: Record<string, unknown> = {
        status: "summarized",
        summarized_at: new Date().toISOString(),
        summary_json: summary,
        korean_title: summary.koreanTitle,
        error_metadata: null,
      };
      if (embedding) {
        updatePayload.embedding = embedding;
      }

      await supabase.from("articles").update(updatePayload).eq("id", row.id);
      await upsertSummaryTags(String(row.id), summary, row.original_published_at);
      summarizedCount += 1;
    } catch (summaryError) {
      failedCount += 1;
      await supabase
        .from("articles")
        .update({
          status: "failed_summary",
          error_metadata: {
            message: summaryError instanceof Error ? summaryError.message : String(summaryError),
          },
        })
        .eq("id", row.id);
    }
  }

  return { mode: "database", summarizedCount, failedCount, skippedCount };
}

export async function runRefreshTagCounts(options: { deleteOrphans?: boolean } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return { mode: "no-database", refreshed: false, message: "Supabase 환경변수가 없어 mock tag count를 사용합니다." };
  }

  const { error } = await supabase.rpc("refresh_tag_counts");
  if (error) throw new Error(error.message);
  if (options.deleteOrphans) {
    const { error: deleteError } = await supabase.from("tags").delete().eq("article_count", 0);
    if (deleteError) throw new Error(deleteError.message);
  }
  return { mode: "database", refreshed: true, deletedOrphans: Boolean(options.deleteOrphans) };
}
