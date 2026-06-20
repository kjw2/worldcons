import { createEmbedding } from "@/lib/ai/embeddings";
import type { LlmCompletionOptions } from "@/lib/ai/client";
import { summarizeArticle } from "@/lib/ai/summarize";
import { generateGlossaryCandidates } from "@/lib/glossary/candidates";
import { getSupabaseAdmin } from "@/lib/db/client";
import type { ArticleContentType, SummaryJson } from "@/lib/db/types";
import { canSummarizeArticle, MIN_PUBLISHABLE_TEXT_LENGTH } from "@/lib/ingest/publishability";
import { syncSummaryTags } from "@/lib/ingest/summary-tags";
import { boundedInteger } from "@/lib/utils/numbers";

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

interface SummarizeArticleOptions extends LlmCompletionOptions {
  articleId?: string;
  slug?: string;
  force?: boolean;
}

const SUMMARY_CANDIDATE_SELECT =
  "id, slug, source_key, jurisdiction, institution_name, content_type, original_url, canonical_url, original_language, original_title, original_published_at, cleaned_text, summary_json, status, source_metadata, updated_at";
const DEFAULT_STALE_SUMMARIZING_MINUTES = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function staleSummarizingMinutes() {
  const value = Number(process.env.STALE_SUMMARIZING_MINUTES ?? DEFAULT_STALE_SUMMARIZING_MINUTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STALE_SUMMARIZING_MINUTES;
}

function staleSummarizingCutoffIso() {
  return new Date(Date.now() - staleSummarizingMinutes() * 60 * 1000).toISOString();
}

function isRetryableSummaryBackoff(message?: string) {
  const lowered = message?.toLowerCase() ?? "";
  return (
    lowered.includes("no gemini routes are locally available") ||
    (lowered.includes("all gemini routes failed") &&
      (lowered.includes('"retryable":true') ||
        lowered.includes(" 429") ||
        lowered.includes(" 500") ||
        lowered.includes(" 502") ||
        lowered.includes(" 503") ||
        lowered.includes(" 504") ||
        lowered.includes("high demand") ||
        lowered.includes("timeout")))
  );
}

export async function recoverStaleSummarizingArticles(options: { limit?: number; sourceKey?: string } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { mode: "no-database", recoveredCount: 0 };

  const limit = boundedInteger(options.limit, 100, { min: 1, max: 500 });
  const cutoff = staleSummarizingCutoffIso();
  let query = supabase
    .from("articles")
    .select("id")
    .eq("status", "summarizing")
    .lt("updated_at", cutoff)
    .limit(limit);

  if (options.sourceKey) {
    query = query.eq("source_key", options.sourceKey);
  }

  const { data, error } = await query;

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
  return { mode: "database", recoveredCount: ids.length, cutoff };
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
    await syncSummaryTags(String(row.id), summary, row.original_published_at, { replace: true });
    return { status: "summarized" as const };
  } catch (summaryError) {
    const message = summaryError instanceof Error ? summaryError.message : String(summaryError);
    const retryableBackoff = isRetryableSummaryBackoff(message);
    await supabase
      .from("articles")
      .update({
        status: forceAllowed || retryableBackoff ? row.status ?? "cleaned" : "failed_summary",
        error_metadata: {
          message,
          retryable: retryableBackoff,
          requestedProvider: options.provider ?? process.env.LLM_PROVIDER ?? "openai",
          requestedModel: options.model ?? null,
        },
      })
      .eq("id", row.id);
    return { status: "failed" as const, errorMessage: message, retryable: retryableBackoff };
  }
}

export async function runSummarizePending(options: { limit?: number; sourceKey?: string } = {}) {
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
  const recoveredStale = await recoverStaleSummarizingArticles({ limit: Math.max(limit, 20), sourceKey: options.sourceKey });
  let query = supabase
    .from("articles")
    .select(SUMMARY_CANDIDATE_SELECT)
    .in("status", ["cleaned", "failed_summary"])
    .is("summarized_at", null)
    .limit(Math.max(limit * 3, limit));

  if (options.sourceKey) {
    query = query.eq("source_key", options.sourceKey);
  }

  const { data, error } = await query;

  if (error) throw new Error(error.message);

  let summarizedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let deferredCount = 0;
  let stoppedReason: string | undefined;

  for (const row of data ?? []) {
    if (summarizedCount >= limit) break;
    const result = await summarizeCandidateRow(supabase, row as SummaryCandidateRow);
    if (result.status === "skipped") {
      skippedCount += 1;
    } else if (result.status === "summarized") {
      summarizedCount += 1;
    } else {
      failedCount += 1;
      if (result.retryable) {
        deferredCount += 1;
        stoppedReason = result.errorMessage;
        break;
      }
    }
  }

  const tagRefresh = summarizedCount > 0 ? await runRefreshTagCounts().catch((error) => ({ refreshed: false, errorMessage: error instanceof Error ? error.message : String(error) })) : undefined;

  return { mode: "database", summarizedCount, failedCount, skippedCount, deferredCount, stoppedReason, recoveredStale, tagRefresh };
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
