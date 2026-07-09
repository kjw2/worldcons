import { getSupabaseAdmin } from "@/lib/db/client";
import type { ArticleContentType, SummaryJson } from "@/lib/db/types";
import { addDiagnosticAttempt, createDiagnosticsCollector } from "@/lib/crawler/diagnostics";
import type { CrawlAttemptLog, CrawlStrategyOption, CrawlerDiagnosticsCollector } from "@/lib/crawler/types";
import { upsertSourceUrlCandidates } from "@/lib/db/source-url-candidates";
import { ARTICLE_ERROR_CLASS, ARTICLE_REVIEW_STATE, classifySummaryError, updateArticleTriageFields } from "@/lib/db/article-triage";
import { createContentHash } from "@/lib/utils/hash";
import { boundedInteger } from "@/lib/utils/numbers";
import { generateArticleSlug } from "@/lib/utils/slug";
import { parseDate } from "@/lib/utils/dates";
import { loadSourceAdapters } from "@/lib/sources/lazy";
import { isConstitutionallyRelevant } from "@/lib/sources/relevance";
import type { DiscoveredItem, NormalizedArticle, SourceAdapter } from "@/lib/sources/types";
import { canonicalizeUrl } from "@/lib/utils/canonical-url";
import { dedupKeysForArticle, uniqueDiscoveredItems } from "@/lib/ingest/dedup";
import { canSummarizeArticle, deriveCollectionStatus, finalizeCollectionMetadata, MIN_PUBLISHABLE_TEXT_LENGTH } from "@/lib/ingest/publishability";
import { syncSummaryTags } from "@/lib/ingest/summary-tags";
import { summarizeArticle } from "@/lib/ai/summarize";
import { createEmbedding } from "@/lib/ai/embeddings";
import { generateGlossaryCandidates } from "@/lib/glossary/candidates";
import type { LlmCompletionOptions } from "@/lib/ai/client";

interface SourceRunResult {
  sourceKey: string;
  discoveredCount: number;
  fetchedCount: number;
  refreshedCount: number;
  unchangedCount: number;
  summarizedCount: number;
  failedCount: number;
  skippedCount: number;
  skippedOutOfRangeCount: number;
  skippedNonConstitutionalCount: number;
  uncollectedCandidates: UncollectedCandidate[];
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

interface UncollectedCandidate {
  sourceKey: string;
  url: string;
  canonicalUrl?: string;
  title?: string | null;
  publishedAt?: string | null;
  candidateType: ArticleContentType;
  discoveredBy: string;
  reason: string;
  errorCode: string;
  httpStatus?: number;
  caseNumber?: string;
  detailDiscoveryStrategy?: string;
  trackedAsRetryCandidate?: boolean;
  trackingError?: string;
  trackedAt?: string;
}

interface RunIngestOptions {
  sourceKey?: string;
  limit?: number;
  debug?: boolean;
  strategy?: CrawlStrategyOption;
  usePlaywright?: boolean;
  allowVercelCrawling?: boolean;
  rangeDays?: number;
  refreshExisting?: boolean;
}

interface SummarizeArticleOptions extends LlmCompletionOptions {
  articleId?: string;
  slug?: string;
  force?: boolean;
}

interface SummaryCandidateRow {
  id: string;
  slug?: string | null;
  source_key: string;
  jurisdiction: string;
  institution_name: string;
  content_type: ArticleContentType;
  original_url: string;
  canonical_url: string;
  original_language: string;
  original_title?: string | null;
  original_published_at?: string | null;
  cleaned_text?: string | null;
  summary_json?: SummaryJson | null;
  status?: string | null;
  source_metadata?: unknown;
  updated_at?: string | null;
}

interface ExistingArticleRow {
  id: string;
  status?: string | null;
  content_hash?: string | null;
  cleaned_text?: string | null;
  source_metadata?: unknown;
}

const SUMMARY_CANDIDATE_SELECT =
  "id, slug, source_key, jurisdiction, institution_name, content_type, original_url, canonical_url, original_language, original_title, original_published_at, cleaned_text, summary_json, status, source_metadata, updated_at";
const DEFAULT_STALE_SUMMARIZING_MINUTES = 30;
const DEFAULT_STANDARD_INGEST_RANGE_DAYS = 14;
const DEFAULT_BVERFG_INGEST_RANGE_DAYS = 60;
const DEFAULT_SPAIN_INGEST_RANGE_DAYS = 180;
const DEFAULT_SPAIN_INGEST_RANGE_CAP_DAYS = 730;
const SPAIN_TC_SOURCE_KEY = "es-tribunal-constitucional";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeCanonicalUrl(value?: string | null) {
  if (!value) return undefined;
  try {
    return canonicalizeUrl(value);
  } catch {
    return value;
  }
}

function inlineCrawlerBlockReason(options: RunIngestOptions = {}) {
  if (process.env.VERCEL !== "1") return null;
  if (process.env.CRAWLEE_WORKER === "true") return null;
  if (process.env.ENABLE_VERCEL_CRAWLING === "true") return null;
  if (options.allowVercelCrawling === true) return null;
  return "Vercel 함수에서는 인라인 수집이 기본 차단되어 있습니다. 관리자 화면에서 Vercel 직접 수집 허용을 켜거나 GitHub Actions Crawlee worker를 실행하세요.";
}

function optionalPositiveInteger(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function effectiveRangeDaysForSource(sourceKey?: string, configuredRangeDays?: number) {
  if (sourceKey === "de-bverfg") {
    const bverfgRangeDays = optionalPositiveInteger(process.env.BVERFG_INGEST_RANGE_DAYS) ?? DEFAULT_BVERFG_INGEST_RANGE_DAYS;
    return configuredRangeDays ? Math.max(configuredRangeDays, bverfgRangeDays) : bverfgRangeDays;
  }

  if (sourceKey === SPAIN_TC_SOURCE_KEY) {
    const spainRangeDays = optionalPositiveInteger(process.env.SPAIN_INGEST_RANGE_DAYS) ?? DEFAULT_SPAIN_INGEST_RANGE_DAYS;
    const cap = optionalPositiveInteger(process.env.SPAIN_INGEST_RANGE_DAYS_CAP) ?? DEFAULT_SPAIN_INGEST_RANGE_CAP_DAYS;
    const rangeDays = configuredRangeDays ? Math.max(configuredRangeDays, spainRangeDays) : spainRangeDays;
    return Math.min(rangeDays, cap);
  }

  if (sourceKey === "us-scotus" || sourceKey === "fr-conseil-constitutionnel") {
    return configuredRangeDays ? Math.max(configuredRangeDays, DEFAULT_STANDARD_INGEST_RANGE_DAYS) : DEFAULT_STANDARD_INGEST_RANGE_DAYS;
  }

  return configuredRangeDays;
}

function rangeDaysForOptions(options: RunIngestOptions = {}, sourceKey?: string) {
  const configuredRangeDays = optionalPositiveInteger(options.rangeDays ?? process.env.INGEST_RANGE_DAYS);
  return effectiveRangeDaysForSource(sourceKey, configuredRangeDays);
}

function rangeStartForDays(days: number) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
}

async function dynamicSpainRangeDays(baseRangeDays?: number) {
  const supabase = getSupabaseAdmin();
  const cap = optionalPositiveInteger(process.env.SPAIN_INGEST_RANGE_DAYS_CAP) ?? DEFAULT_SPAIN_INGEST_RANGE_CAP_DAYS;
  const base = baseRangeDays ?? DEFAULT_SPAIN_INGEST_RANGE_DAYS;
  if (!supabase) return Math.min(base, cap);

  const { data } = await supabase
    .from("ingestion_runs")
    .select("finished_at, started_at")
    .eq("source_key", SPAIN_TC_SOURCE_KEY)
    .eq("status", "completed")
    .order("finished_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  const latest = data?.finished_at ?? data?.started_at;
  if (!latest) return Math.min(base, cap);
  const timestamp = new Date(latest).getTime();
  if (!Number.isFinite(timestamp)) return Math.min(base, cap);
  const daysSinceLastRun = Math.ceil((Date.now() - timestamp) / (24 * 60 * 60 * 1000));
  return Math.min(Math.max(base, daysSinceLastRun + 30), cap);
}

function isItemInDateRange(publishedAt: string | undefined, rangeStart: Date | undefined) {
  if (!rangeStart) return true;
  const parsed = parseDate(publishedAt);
  return Boolean(parsed && parsed >= rangeStart);
}

function shouldRefreshExistingArticles(options: RunIngestOptions = {}, sourceKey?: string) {
  if (typeof options.refreshExisting === "boolean") return options.refreshExisting;
  const env = process.env.INGEST_REFRESH_EXISTING;
  if (env !== undefined && env !== "") return !["0", "false", "no", "off"].includes(env.toLowerCase());
  return Boolean(rangeDaysForOptions(options, sourceKey));
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

async function closeIngestionRun(runId: string | null, result: SourceRunResult, status = "completed", runOptions?: Record<string, unknown>) {
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
        runOptions,
        skippedCount: result.skippedCount,
        errors: result.errors.slice(0, 10),
        diagnostics: result.diagnostics,
        fallbackUsed: Boolean(result.diagnostics?.attempts.some((attempt) => attempt.fallback || attempt.strategy === "seed")),
        uncollectedCandidateCount: result.uncollectedCandidates.length,
        uncollectedCandidates: result.uncollectedCandidates.slice(0, 20),
        statusCounts: result.statusCounts,
        collectionCounts: result.collectionCounts,
        refreshedCount: result.refreshedCount,
        unchangedCount: result.unchangedCount,
        skippedOutOfRangeCount: result.skippedOutOfRangeCount,
        skippedNonConstitutionalCount: result.skippedNonConstitutionalCount,
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

export async function articleExists(canonicalUrl: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;

  const { data } = await supabase.from("articles").select("id").eq("canonical_url", canonicalUrl).maybeSingle();
  return Boolean(data);
}

async function findExistingArticle(canonicalUrl: string): Promise<ExistingArticleRow | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("articles")
    .select("id, status, content_hash, cleaned_text, source_metadata")
    .eq("canonical_url", canonicalUrl)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as ExistingArticleRow | null;
}

export async function articleExistsByNormalizedContent(article: NormalizedArticle) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;

  const contentHash = createContentHash(article.cleanedText);
  if (contentHash) {
    const { data, error } = await supabase.from("articles").select("id").eq("source_key", article.sourceKey).eq("content_hash", contentHash).maybeSingle();
    if (!error && data) return true;
  }

  if (article.originalTitle && article.originalPublishedAt) {
    const caseNumber = typeof article.metadata?.caseNumber === "string" ? article.metadata.caseNumber : null;
    if (caseNumber) {
      const { data } = await supabase
        .from("articles")
        .select("id")
        .eq("source_key", article.sourceKey)
        .eq("original_title", article.originalTitle)
        .eq("original_published_at", article.originalPublishedAt)
        .filter("source_metadata->>caseNumber", "eq", caseNumber)
        .maybeSingle();
      return Boolean(data);
    }

    if (!isGenericCourtTitle(article)) {
      const { data } = await supabase
        .from("articles")
        .select("id")
        .eq("source_key", article.sourceKey)
        .eq("original_title", article.originalTitle)
        .eq("original_published_at", article.originalPublishedAt)
        .maybeSingle();
      return Boolean(data);
    }
  }

  return false;
}

function staleSummarizingMinutes() {
  const value = Number(process.env.STALE_SUMMARIZING_MINUTES ?? DEFAULT_STALE_SUMMARIZING_MINUTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STALE_SUMMARIZING_MINUTES;
}

function staleSummarizingCutoffIso() {
  return new Date(Date.now() - staleSummarizingMinutes() * 60 * 1000).toISOString();
}

export async function recoverStaleSummarizingArticles(options: { limit?: number } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { mode: "no-database", recoveredCount: 0 };

  const limit = boundedInteger(options.limit, 100, { min: 1, max: 500 });
  const cutoff = staleSummarizingCutoffIso();
  const { data, error } = await supabase
    .from("articles")
    .select("id")
    .eq("status", "summarizing")
    .lt("updated_at", cutoff)
    .limit(limit);

  if (error) throw new Error(error.message);
  const ids = (data ?? []).map((row) => String(row.id)).filter(Boolean);
  if (ids.length === 0) return { mode: "database", recoveredCount: 0, cutoff };

  const { error: updateError } = await supabase
    .from("articles")
    .update({
      status: "failed_summary",
      error_metadata: {
        message: `Stale summarizing state recovered after ${staleSummarizingMinutes()} minutes. Retry summary from the admin review screen.`,
      },
    })
    .in("id", ids);

  if (updateError) throw new Error(updateError.message);
  await updateArticleTriageFields({
    articleIds: ids,
    errorClass: ARTICLE_ERROR_CLASS.JOB_STALE_RUNNING,
    errorContext: { message: `Stale summarizing state recovered after ${staleSummarizingMinutes()} minutes.` },
    reviewState: ARTICLE_REVIEW_STATE.NEEDS_TRIAGE,
  });
  return { mode: "database", recoveredCount: ids.length, cutoff };
}

function isGenericCourtTitle(article: NormalizedArticle) {
  if (article.sourceKey !== "de-bverfg") return false;
  const title = article.originalTitle?.trim() ?? "";
  return /^(?:Beschluss|Urteil)\s+vom\s+\d{1,2}\.\s+[A-Za-zÄÖÜäöüß]+\s+\d{4}$/i.test(title);
}

function isUnverifiedBverfgFetch(article: NormalizedArticle) {
  if (article.sourceKey !== "de-bverfg") return false;
  const collection = isRecord(article.metadata?.collection) ? article.metadata.collection : {};
  return collection.sourceUrlVerified === false || /^HTTP Status \d+/i.test(article.originalTitle ?? "");
}

function diagnosticsForArticle(article: NormalizedArticle) {
  const diagnostics = isRecord(article.metadata) ? article.metadata.diagnostics : null;
  return Array.isArray(diagnostics) ? (diagnostics as CrawlAttemptLog[]) : [];
}

function latestProblemAttempt(attempts: CrawlAttemptLog[], urls: Array<string | undefined | null>) {
  const targetUrls = new Set(urls.map((url) => safeCanonicalUrl(url)).filter(Boolean));
  const reversed = [...attempts].reverse();
  const matchingAttempt = reversed.find((attempt) => {
    const attemptUrl = safeCanonicalUrl(attempt.finalUrl ?? attempt.url);
    const status = attempt.status ?? attempt.statusCode ?? undefined;
    return Boolean(attemptUrl && targetUrls.has(attemptUrl) && status && status >= 400);
  });

  return (
    matchingAttempt ??
    reversed.find((attempt) => {
      const status = attempt.status ?? attempt.statusCode ?? undefined;
      return Boolean(status && status >= 400);
    })
  );
}

function statusFromAttempt(attempt?: CrawlAttemptLog) {
  const status = attempt?.status ?? attempt?.statusCode;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

function bverfgUncollectedReason(status?: number) {
  if (status === 404) {
    return "BVerfG official detail URL returned HTTP 404. The external index candidate is saved for later retry in case the official page appears or the URL pattern changes.";
  }
  if (status && status >= 400) {
    return `BVerfG official detail URL returned HTTP ${status}. The candidate is saved for later retry.`;
  }
  return "BVerfG official detail URL could not be verified. The candidate is saved for later retry.";
}

function bverfgUncollectedErrorCode(status?: number, fallback?: string) {
  if (status === 404) return "BVERFG_OFFICIAL_DETAIL_404";
  if (status && status >= 400) return `BVERFG_OFFICIAL_DETAIL_${status}`;
  return fallback ?? "BVERFG_OFFICIAL_DETAIL_UNVERIFIED";
}

function uncollectedCandidateForArticle(article: NormalizedArticle, diagnostics?: CrawlerDiagnosticsCollector): UncollectedCandidate | null {
  if (!isUnverifiedBverfgFetch(article)) return null;

  const metadata = isRecord(article.metadata) ? article.metadata : {};
  const attempt = latestProblemAttempt([...diagnosticsForArticle(article), ...(diagnostics?.attempts ?? [])], [article.canonicalUrl, article.originalUrl]);
  const httpStatus = statusFromAttempt(attempt);
  const detailDiscoveryStrategy = stringValue(metadata.detailDiscoveryStrategy);
  const discoveredBy = detailDiscoveryStrategy ?? stringValue(metadata.discoveryIndex) ?? "official-detail-verification";

  return {
    sourceKey: article.sourceKey,
    url: article.originalUrl,
    canonicalUrl: article.canonicalUrl,
    title: article.originalTitle ?? null,
    publishedAt: article.originalPublishedAt ?? null,
    candidateType: article.contentType,
    discoveredBy,
    reason: bverfgUncollectedReason(httpStatus),
    errorCode: bverfgUncollectedErrorCode(httpStatus, attempt?.errorCode),
    httpStatus,
    caseNumber: stringValue(metadata.caseNumber),
    detailDiscoveryStrategy,
  };
}

function uncollectedCandidateForFailedItem(item: DiscoveredItem, diagnostics: CrawlerDiagnosticsCollector, error: unknown): UncollectedCandidate | null {
  if (item.sourceKey !== "de-bverfg") return null;

  const attempt = latestProblemAttempt(diagnostics.attempts, [item.canonicalUrl, item.url]);
  const httpStatus = statusFromAttempt(attempt);
  if (!httpStatus || httpStatus < 400) return null;

  const metadata = isRecord(item.metadata) ? item.metadata : {};
  const detailDiscoveryStrategy = stringValue(metadata.detailDiscoveryStrategy);
  const discoveredBy = detailDiscoveryStrategy ?? stringValue(metadata.discoveryIndex) ?? "official-detail-verification";
  const errorCode = bverfgUncollectedErrorCode(httpStatus, attempt?.errorCode);

  return {
    sourceKey: item.sourceKey,
    url: item.url,
    canonicalUrl: item.canonicalUrl,
    title: item.title ?? null,
    publishedAt: item.publishedAt ?? null,
    candidateType: item.contentType,
    discoveredBy,
    reason: `${bverfgUncollectedReason(httpStatus)} Fetch error: ${error instanceof Error ? error.message : String(error)}`,
    errorCode,
    httpStatus,
    caseNumber: stringValue(metadata.caseNumber),
    detailDiscoveryStrategy,
  };
}

function uncollectedCandidateErrorMessage(candidate: UncollectedCandidate) {
  return [
    candidate.title,
    candidate.publishedAt,
    candidate.caseNumber ? `case ${candidate.caseNumber}` : null,
    candidate.reason,
  ]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 1000);
}

async function trackUncollectedCandidate(candidate: UncollectedCandidate) {
  const trackedAt = new Date().toISOString();
  const result = await upsertSourceUrlCandidates([
    {
      sourceKey: candidate.sourceKey,
      url: candidate.canonicalUrl ?? candidate.url,
      candidateType: candidate.candidateType,
      discoveredBy: candidate.discoveredBy,
      status: "retrying",
      lastErrorCode: candidate.errorCode,
      lastErrorMessage: uncollectedCandidateErrorMessage(candidate),
    },
  ]);
  const trackingError =
    "error" in result && result.error
      ? result.error
      : result.inserted === 0
        ? "Source URL candidate store is not configured."
        : undefined;

  return {
    ...candidate,
    trackedAsRetryCandidate: !trackingError,
    trackingError,
    trackedAt,
  };
}

function storagePlanForArticle(article: NormalizedArticle, diagnosticsId?: string | null) {
  const constitutionalRelevant = article.sourceKey !== "us-scotus" || isConstitutionallyRelevant(article);
  if (isUnverifiedBverfgFetch(article)) {
    return {
      skipped: true as const,
      reason: "BVerfG official detail URL was not verified, so the derived candidate is skipped.",
    };
  }

  if (article.sourceKey === "us-scotus" && (article.contentType !== "opinion" || !constitutionalRelevant)) {
    return {
      skipped: true as const,
      reason: article.contentType !== "opinion"
        ? "SCOTUS collection is limited to opinions."
        : "SCOTUS opinion did not match the constitutional relevance keyword policy.",
    };
  }

  const collection = finalizeCollectionMetadata(article, diagnosticsId, constitutionalRelevant);
  const status = deriveCollectionStatus({
    ...article,
    metadata: {
      ...article.metadata,
      collection,
    },
  });

  return {
    skipped: false as const,
    status,
    collection,
    constitutionalRelevant,
  };
}

function sourceMetadataForArticle(
  article: NormalizedArticle,
  collection: ReturnType<typeof finalizeCollectionMetadata>,
  constitutionalRelevant: boolean,
  previous?: ExistingArticleRow,
) {
  const dedupKeys = dedupKeysForArticle(article);
  const previousMetadata = isRecord(previous?.source_metadata) ? previous.source_metadata : {};

  return {
    ...previousMetadata,
    ...article.metadata,
    collection,
    dedupKeys,
    constitutionalKeywordRelevant: article.sourceKey === "us-scotus" ? constitutionalRelevant : undefined,
    refreshedFromOfficialAt: previous ? new Date().toISOString() : undefined,
    previousContentHash: previous?.content_hash ?? undefined,
  };
}

export async function insertNormalizedArticle(article: NormalizedArticle, diagnosticsId?: string | null) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const sourceId = await findSourceId(article.sourceKey);
  const plan = storagePlanForArticle(article, diagnosticsId);
  if (plan.skipped) return null;
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
      status: plan.status,
      slug,
      raw_text: article.rawText,
      cleaned_text: article.cleanedText,
      content_hash: createContentHash(article.cleanedText) ?? dedupKeys.textPrefixHash,
      source_metadata: sourceMetadataForArticle(article, plan.collection, plan.constitutionalRelevant),
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return { id: String(data.id), status: plan.status, collection: plan.collection };
}

async function refreshExistingArticle(existing: ExistingArticleRow, article: NormalizedArticle, diagnosticsId?: string | null) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { status: "skipped" as const, reason: "Supabase is not configured." };

  const plan = storagePlanForArticle(article, diagnosticsId);
  if (plan.skipped) {
    return { status: "skipped_nonconstitutional" as const, reason: plan.reason };
  }

  const dedupKeys = dedupKeysForArticle(article);
  const contentHash = createContentHash(article.cleanedText) ?? dedupKeys.textPrefixHash;
  const existingHash = existing.content_hash ?? createContentHash(existing.cleaned_text);
  if (contentHash && existingHash && contentHash === existingHash) {
    return { status: "unchanged" as const };
  }

  const { error } = await supabase
    .from("articles")
    .update({
      jurisdiction: article.jurisdiction,
      institution_name: article.institutionName,
      content_type: article.contentType,
      original_url: article.originalUrl,
      canonical_url: article.canonicalUrl,
      original_language: article.originalLanguage,
      original_title: article.originalTitle,
      original_published_at: article.originalPublishedAt,
      fetched_at: new Date().toISOString(),
      summarized_at: null,
      status: plan.status,
      korean_title: null,
      summary_json: null,
      raw_text: article.rawText,
      cleaned_text: article.cleanedText,
      content_hash: contentHash,
      error_metadata: null,
      source_metadata: sourceMetadataForArticle(article, plan.collection, plan.constitutionalRelevant, existing),
    })
    .eq("id", existing.id);

  if (error) throw new Error(error.message);
  await supabase.from("article_tags").delete().eq("article_id", existing.id);

  return { status: "refreshed" as const, articleStatus: plan.status, collection: plan.collection };
}

async function runSingleSource(adapter: SourceAdapter, limit: number, options: RunIngestOptions = {}): Promise<SourceRunResult> {
  const result: SourceRunResult = {
    sourceKey: adapter.sourceKey,
    discoveredCount: 0,
    fetchedCount: 0,
    refreshedCount: 0,
    unchangedCount: 0,
    summarizedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    skippedOutOfRangeCount: 0,
    skippedNonConstitutionalCount: 0,
    uncollectedCandidates: [],
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
  let rangeDays = rangeDaysForOptions(options, adapter.sourceKey);
  if (adapter.sourceKey === SPAIN_TC_SOURCE_KEY) {
    rangeDays = await dynamicSpainRangeDays(rangeDays);
  }
  const rangeStart = rangeDays ? rangeStartForDays(rangeDays) : undefined;
  const refreshExisting = shouldRefreshExistingArticles(options, adapter.sourceKey);
  const discoveryOptions = {
    debug: options.debug,
    limit,
    rangeDays,
    strategy: options.strategy ?? "auto",
    usePlaywright: options.usePlaywright,
    diagnostics: result.diagnostics,
  };
  const runOptionsMetadata = {
    sourceKey: adapter.sourceKey,
    limit,
    rangeDays: rangeDays ?? null,
    strategy: discoveryOptions.strategy,
    usePlaywright: discoveryOptions.usePlaywright ?? null,
    allowVercelCrawling: options.allowVercelCrawling === true,
    refreshExisting,
  };

  try {
    const allDiscovered = uniqueDiscoveredItems(await adapter.discover(discoveryOptions));
    result.discoveredCount = allDiscovered.length;
    const inRangeDiscovered = allDiscovered.filter((item) => isItemInDateRange(item.publishedAt, rangeStart));
    const discovered = inRangeDiscovered.slice(0, limit);
    result.skippedOutOfRangeCount = allDiscovered.length - inRangeDiscovered.length;

    for (const item of discovered) {
      const itemDiagnostics = createDiagnosticsCollector(adapter.sourceKey);
      let itemDiagnosticsMerged = false;
      try {
        if (adapter.sourceKey === "us-scotus" && item.contentType !== "opinion") {
          result.skippedNonConstitutionalCount += 1;
          result.skippedCount += 1;
          continue;
        }

        const existing = await findExistingArticle(item.canonicalUrl);
        if (existing && !refreshExisting) {
          result.skippedCount += 1;
          continue;
        }

        const raw = await adapter.fetchItem(item, { ...discoveryOptions, diagnostics: itemDiagnostics });
        itemDiagnostics.attempts.forEach((attempt) => addDiagnosticAttempt(result.diagnostics, attempt));
        itemDiagnosticsMerged = true;
        const normalized = await adapter.normalize(raw);
        const uncollectedCandidate = uncollectedCandidateForArticle(normalized, result.diagnostics);
        if (uncollectedCandidate) {
          result.uncollectedCandidates.push(await trackUncollectedCandidate(uncollectedCandidate));
          result.skippedCount += 1;
          result.fetchedCount += 1;
          continue;
        }

        if (adapter.sourceKey === "us-scotus" && !isConstitutionallyRelevant(normalized)) {
          result.skippedNonConstitutionalCount += 1;
          result.skippedCount += 1;
          continue;
        }

        if (existing) {
          const refreshed = await refreshExistingArticle(existing, normalized, runId);
          if (refreshed.status === "unchanged") {
            result.unchangedCount += 1;
            result.skippedCount += 1;
          } else if (refreshed.status === "refreshed") {
            result.refreshedCount += 1;
            result.statusCounts[refreshed.articleStatus] = (result.statusCounts[refreshed.articleStatus] ?? 0) + 1;
            if (refreshed.collection.publishable) result.collectionCounts.publishableCount += 1;
            if (!refreshed.collection.sourceTextAvailable) result.collectionCounts.metadataOnlyCount += 1;
            if (refreshed.collection.robotsDisallowed) result.collectionCounts.robotsDisallowedCount += 1;
            if (refreshed.articleStatus === "blocked") result.collectionCounts.blockedCount += 1;
            if (refreshed.articleStatus === "timeout") result.collectionCounts.timeoutCount += 1;
            if (refreshed.collection.strategy === "seed") result.collectionCounts.seedCount += 1;
          } else {
            result.skippedNonConstitutionalCount += 1;
            result.skippedCount += 1;
          }
          result.fetchedCount += 1;
          continue;
        }

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
        if (!itemDiagnosticsMerged) {
          itemDiagnostics.attempts.forEach((attempt) => addDiagnosticAttempt(result.diagnostics, attempt));
        }
        const uncollectedCandidate = uncollectedCandidateForFailedItem(item, itemDiagnostics, error);
        if (uncollectedCandidate) {
          result.uncollectedCandidates.push(await trackUncollectedCandidate(uncollectedCandidate));
          result.skippedCount += 1;
        } else {
          result.failedCount += 1;
          result.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    await closeIngestionRun(runId, result, "completed", runOptionsMetadata);
    return result;
  } catch (error) {
    result.failedCount += 1;
    result.errors.push(error instanceof Error ? error.message : String(error));
    await closeIngestionRun(runId, result, "failed", runOptionsMetadata);
    return result;
  }
}

export async function runIngest(options: RunIngestOptions = {}) {
  const limit = boundedInteger(options.limit ?? process.env.INGEST_LIMIT_PER_SOURCE, 20, { min: 1, max: 100 });
  const blocked = inlineCrawlerBlockReason(options);
  if (blocked) {
    return {
      mode: "blocked",
      message: blocked,
      results: [],
    };
  }

  const activeSourceKeys = await getActiveSourceKeys();
  const selectedAdapters = await loadSourceAdapters({ sourceKey: options.sourceKey, activeSourceKeys });

  if (!getSupabaseAdmin()) {
    const discovered = await Promise.allSettled(
      selectedAdapters.map((adapter) => {
        const diagnostics = createDiagnosticsCollector(adapter.sourceKey);
        const rangeDays = rangeDaysForOptions(options, adapter.sourceKey);
        return adapter.discover({
          debug: options.debug,
          limit,
          rangeDays,
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
        discoveredCount: result.status === "fulfilled" ? result.value.items.length : 0,
        fetchedCount: 0,
        refreshedCount: 0,
        unchangedCount: 0,
        summarizedCount: 0,
        failedCount: result.status === "rejected" ? 1 : 0,
        skippedCount: 0,
        skippedOutOfRangeCount:
          result.status === "fulfilled"
            ? result.value.items.filter((item) => {
                const rangeDays = rangeDaysForOptions(options, selectedAdapters[index]?.sourceKey);
                const rangeStart = rangeDays ? rangeStartForDays(rangeDays) : undefined;
                return !isItemInDateRange(item.publishedAt, rangeStart);
              }).length
            : 0,
        skippedNonConstitutionalCount: 0,
        uncollectedCandidates: [],
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

async function summarizeCandidateRow(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  row: SummaryCandidateRow,
  options: Pick<SummarizeArticleOptions, "provider" | "model" | "force"> = {},
) {
  const collection = isRecord(row.source_metadata) && isRecord(row.source_metadata.collection) ? row.source_metadata.collection : {};
  const forceAllowed =
    options.force === true &&
    row.status === "summarized" &&
    typeof row.cleaned_text === "string" &&
    row.cleaned_text.trim().length >= MIN_PUBLISHABLE_TEXT_LENGTH &&
    collection.publishable === true;

  if (!canSummarizeArticle(row) && !forceAllowed) {
    return {
      status: "skipped" as const,
      reason: "Article is not eligible for summarization. It must have verified publishable source text.",
    };
  }

  await supabase
    .from("articles")
    .update({
      ...(forceAllowed ? {} : { status: "summarizing" }),
      error_metadata: null,
    })
    .eq("id", row.id);

  try {
    const summary = await summarizeArticle({
      sourceKey: row.source_key,
      jurisdiction: row.jurisdiction,
      institutionName: row.institution_name,
      contentType: row.content_type,
      originalUrl: row.original_url,
      canonicalUrl: row.canonical_url,
      originalLanguage: row.original_language,
      originalTitle: row.original_title ?? undefined,
      originalPublishedAt: row.original_published_at ?? undefined,
      cleanedText: row.cleaned_text ?? undefined,
    }, { provider: options.provider, model: options.model });
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
    await updateArticleTriageFields({
      articleId: row.id,
      errorClass: null,
      errorContext: null,
      reviewState: ARTICLE_REVIEW_STATE.SUMMARIZED,
    });
    await syncSummaryTags(String(row.id), summary, row.original_published_at, { replace: true });
    return { status: "summarized" as const };
  } catch (summaryError) {
    const message = summaryError instanceof Error ? summaryError.message : String(summaryError);
    const requestedProvider = options.provider ?? process.env.LLM_PROVIDER ?? "openai";
    const requestedModel = options.model ?? null;
    await supabase
      .from("articles")
      .update({
        status: forceAllowed ? row.status : "failed_summary",
        error_metadata: {
          message,
          requestedProvider,
          requestedModel,
        },
      })
      .eq("id", row.id);
    await updateArticleTriageFields({
      articleId: row.id,
      errorClass: classifySummaryError(message),
      errorContext: {
        message,
        requestedProvider,
        requestedModel,
      },
      reviewState: ARTICLE_REVIEW_STATE.NEEDS_TRIAGE,
    });
    return { status: "failed" as const, errorMessage: message };
  }
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

  const limit = boundedInteger(options.limit, 10, { min: 1, max: 100 });
  const recoveredStale = await recoverStaleSummarizingArticles({ limit: Math.max(limit, 20) });
  const { data, error } = await supabase
    .from("articles")
    .select(SUMMARY_CANDIDATE_SELECT)
    .in("status", ["cleaned", "failed_summary"])
    .is("summarized_at", null)
    .limit(Math.max(limit * 3, limit));

  if (error) throw new Error(error.message);

  let summarizedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const row of data ?? []) {
    if (summarizedCount >= limit) break;
    const result = await summarizeCandidateRow(supabase, row as SummaryCandidateRow);
    if (result.status === "skipped") {
      skippedCount += 1;
    } else if (result.status === "summarized") {
      summarizedCount += 1;
    } else {
      failedCount += 1;
    }
  }

  const tagRefresh = summarizedCount > 0 ? await runRefreshTagCounts().catch((error) => ({ refreshed: false, errorMessage: error instanceof Error ? error.message : String(error) })) : undefined;

  return { mode: "database", summarizedCount, failedCount, skippedCount, recoveredStale, tagRefresh };
}

export async function runSummarizeArticle(options: SummarizeArticleOptions) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return {
      mode: "no-database",
      status: "skipped",
      summarizedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      message: "Supabase 환경변수가 없어 DB 요약 작업을 건너뜁니다.",
    };
  }

  if (!options.articleId && !options.slug) {
    return {
      mode: "database",
      status: "skipped",
      summarizedCount: 0,
      failedCount: 0,
      skippedCount: 1,
      reason: "articleId or slug is required.",
    };
  }

  let query = supabase.from("articles").select(SUMMARY_CANDIDATE_SELECT);
  query = options.articleId ? query.eq("id", options.articleId) : query.eq("slug", options.slug);
  const { data, error } = await query.maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) {
    return {
      mode: "database",
      status: "not_found",
      summarizedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      reason: "Article not found.",
    };
  }

  const row = data as SummaryCandidateRow;
  const result = await summarizeCandidateRow(supabase, row, options);
  const tagRefresh =
    result.status === "summarized"
      ? await runRefreshTagCounts().catch((refreshError) => ({
          refreshed: false,
          errorMessage: refreshError instanceof Error ? refreshError.message : String(refreshError),
        }))
      : undefined;

  return {
    mode: "database",
    articleId: row.id,
    slug: row.slug,
    status: result.status,
    summarizedCount: result.status === "summarized" ? 1 : 0,
    failedCount: result.status === "failed" ? 1 : 0,
    skippedCount: result.status === "skipped" ? 1 : 0,
    errorMessage: result.status === "failed" ? result.errorMessage : undefined,
    reason: result.status === "skipped" ? result.reason : undefined,
    tagRefresh,
  };
}

export async function runRefreshTagCounts(options: { deleteOrphans?: boolean } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return { mode: "no-database", refreshed: false, message: "Supabase 환경변수가 없어 mock tag count를 사용합니다." };
  }

  const { error } = await supabase.rpc("refresh_tag_counts");
  if (error) throw new Error(`refresh_tag_counts RPC failed: ${error.message}`);

  let deletedOrphans = false;
  if (options.deleteOrphans) {
    const { error: deleteError } = await supabase.from("tags").delete().eq("article_count", 0);
    if (deleteError) throw new Error(deleteError.message);
    deletedOrphans = true;
  }

  const { count, error: countError } = await supabase.from("tags").select("id", { count: "exact", head: true });
  if (countError) throw new Error(countError.message);

  const glossaryCandidates = await generateGlossaryCandidates({ persist: true }).catch((error) => ({
    mode: "error" as const,
    errorMessage: error instanceof Error ? error.message : String(error),
  }));

  return { mode: "database", refreshed: true, strategy: "rpc", updatedTags: count ?? undefined, deletedOrphans, glossaryCandidates };
}
