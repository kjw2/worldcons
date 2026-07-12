import { getSupabaseAdmin } from "@/lib/db/client";
import { ARTICLE_REVIEW_STATE, updateArticleTriageFields } from "@/lib/db/article-triage";
import type { LlmCompletionOptions } from "@/lib/ai/client";
import { MIN_PUBLISHABLE_TEXT_LENGTH } from "@/lib/ingest/publishability";
import { runRefreshTagCounts, runSummarizeArticle } from "@/lib/ingest/summary";
import {
  ARTICLE_LIFECYCLE_COLLECTION_ATTENTION_CODES,
  ARTICLE_LIFECYCLE_SUMMARY_ATTENTION_CODES,
  shadowArticleLifecycleTransition,
} from "@/lib/article-lifecycle";

export type AdminReviewAction =
  | "approve-and-summarize"
  | "retry-summary"
  | "resummarize-with-model"
  | "publish-reviewed"
  | "close-private"
  | "retry-source-ingest";

interface ReviewArticleRow {
  id: string;
  slug?: string | null;
  source_key: string;
  status: string;
  cleaned_text?: string | null;
  raw_text?: string | null;
  summary_json?: unknown;
  source_metadata?: unknown;
  error_metadata?: unknown;
}

interface ReviewActionInput {
  action: AdminReviewAction;
  articleId?: string;
  slug?: string;
  note?: string;
  provider?: LlmCompletionOptions["provider"];
  model?: string;
}

const REVIEW_ARTICLE_SELECT = "id, slug, source_key, status, cleaned_text, raw_text, summary_json, source_metadata, error_metadata";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textLength(value?: string | null) {
  return (value ?? "").trim().length;
}

function hasPublishableCleanedText(row: ReviewArticleRow) {
  return textLength(row.cleaned_text) >= MIN_PUBLISHABLE_TEXT_LENGTH;
}

function reviewMetadata(
  row: ReviewArticleRow,
  decision: string,
  note?: string,
  collectionOverrides: Record<string, unknown> = {},
  reviewExtras: Record<string, unknown> = {},
) {
  const metadata = isRecord(row.source_metadata) ? row.source_metadata : {};
  const collection = isRecord(metadata.collection) ? metadata.collection : {};
  const reviewHistory = Array.isArray(metadata.reviewHistory) ? metadata.reviewHistory : [];
  const reviewedAt = new Date().toISOString();
  const review = {
    decision,
    note: note?.trim() || undefined,
    reviewedAt,
    previousStatus: row.status,
    ...reviewExtras,
  };

  return {
    ...metadata,
    collection: {
      ...collection,
      ...collectionOverrides,
    },
    review,
    reviewHistory: [...reviewHistory.slice(-19), review],
  };
}

function isPublicSummarized(row: ReviewArticleRow) {
  const metadata = isRecord(row.source_metadata) ? row.source_metadata : {};
  const collection = isRecord(metadata.collection) ? metadata.collection : {};
  return row.status === "summarized" && Boolean(row.summary_json) && collection.publishable === true;
}

function normalizeProvider(provider?: LlmCompletionOptions["provider"], model?: string): LlmCompletionOptions["provider"] {
  if (provider === "openai" || provider === "gemini" || provider === "anthropic" || provider === "openai-compatible") return provider;
  if (/^claude-/i.test(model ?? "")) return "anthropic";
  if (/^gpt-|^o\d|^chatgpt-/i.test(model ?? "")) return "openai";
  return "gemini";
}

async function findReviewArticle(articleId?: string, slug?: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { supabase: null, row: null };
  if (!articleId && !slug) return { supabase, row: null };

  let query = supabase.from("articles").select(REVIEW_ARTICLE_SELECT);
  query = articleId ? query.eq("id", articleId) : query.eq("slug", slug);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return { supabase, row: data ? (data as ReviewArticleRow) : null };
}

async function updateArticleForSummary(row: ReviewArticleRow, note?: string) {
  const { supabase } = await findReviewArticle(row.id);
  if (!supabase) return;

  const sourceTextLength = textLength(row.cleaned_text);
  const sourceMetadata = reviewMetadata(row, "approved_for_summary", note, {
    publishable: true,
    sourceTextAvailable: true,
    sourceUrlVerified: true,
    robotsDisallowed: false,
    confidence: "human_reviewed",
    reason: `Human review approved summarization and publication eligibility (${sourceTextLength} chars).`,
  });

  const { error } = await supabase
    .from("articles")
    .update({
      status: "cleaned",
      source_metadata: sourceMetadata,
      error_metadata: null,
    })
    .eq("id", row.id);
  if (error) throw new Error(error.message);
  const triageUpdated = await updateArticleTriageFields({
    articleId: row.id,
    errorClass: null,
    errorContext: null,
    reviewState: ARTICLE_REVIEW_STATE.APPROVED_FOR_SUMMARY,
  });
  await shadowArticleLifecycleTransition({
    articleId: row.id,
    cohort: "review",
    actorType: "admin",
    source: "admin.review",
    reasonCode: "legacy.review.approved_for_summary",
    collectionState: "source_text_ready",
    processingState: "ready",
    reviewState: triageUpdated ? "approved_for_processing" : undefined,
    attention: { operation: "clear", resolvesCodes: [...ARTICLE_LIFECYCLE_COLLECTION_ATTENTION_CODES] },
  });
}

async function publishReviewedArticle(row: ReviewArticleRow, note?: string) {
  const { supabase } = await findReviewArticle(row.id);
  if (!supabase) return { status: "skipped" as const, reason: "Supabase is not configured." };
  if (!row.summary_json) {
    return { status: "skipped" as const, reason: "요약 JSON이 없어 바로 공개할 수 없습니다. 먼저 요약을 실행해야 합니다." };
  }

  const sourceMetadata = reviewMetadata(row, "published", note, {
    publishable: true,
    sourceTextAvailable: hasPublishableCleanedText(row),
    sourceUrlVerified: true,
    robotsDisallowed: false,
    confidence: "human_reviewed",
    reason: "Human review approved publication.",
  });

  const { error } = await supabase
    .from("articles")
    .update({
      status: "summarized",
      summarized_at: new Date().toISOString(),
      source_metadata: sourceMetadata,
      error_metadata: null,
    })
    .eq("id", row.id);
  if (error) throw new Error(error.message);
  const triageUpdated = await updateArticleTriageFields({
    articleId: row.id,
    errorClass: null,
    errorContext: null,
    reviewState: ARTICLE_REVIEW_STATE.PUBLISHED,
  });
  await shadowArticleLifecycleTransition({
    articleId: row.id,
    cohort: "review",
    actorType: "admin",
    source: "admin.review",
    reasonCode: "legacy.review.approved",
    collectionState: "source_text_ready",
    processingState: "complete",
    reviewState: triageUpdated ? "approved" : undefined,
    attention: {
      operation: "clear",
      resolvesCodes: [...ARTICLE_LIFECYCLE_COLLECTION_ATTENTION_CODES, ...ARTICLE_LIFECYCLE_SUMMARY_ATTENTION_CODES],
    },
  });
  await runRefreshTagCounts().catch(() => null);
  return { status: "published" as const };
}

async function closePrivate(row: ReviewArticleRow, note?: string) {
  const { supabase } = await findReviewArticle(row.id);
  if (!supabase) return { status: "skipped" as const, reason: "Supabase is not configured." };

  const sourceMetadata = reviewMetadata(row, "closed_private", note, {
    publishable: false,
    confidence: "human_reviewed",
    reason: note?.trim() || "Human review closed this item as private.",
  });

  const { error } = await supabase
    .from("articles")
    .update({
      status: "needs_review",
      source_metadata: sourceMetadata,
      error_metadata: null,
    })
    .eq("id", row.id);
  if (error) throw new Error(error.message);
  const triageUpdated = await updateArticleTriageFields({
    articleId: row.id,
    errorClass: null,
    errorContext: null,
    reviewState: ARTICLE_REVIEW_STATE.CLOSED_PRIVATE,
  });
  if (triageUpdated) {
    await shadowArticleLifecycleTransition({
      articleId: row.id,
      cohort: "review",
      actorType: "admin",
      source: "admin.review",
      reasonCode: "legacy.review.closed_private",
      reviewState: "closed_private",
    });
  }
  return { status: "closed_private" as const };
}

async function recordManualResummary(row: ReviewArticleRow, provider: LlmCompletionOptions["provider"], model: string, note?: string) {
  const { supabase } = await findReviewArticle(row.id);
  if (!supabase) return;

  const sourceMetadata = reviewMetadata(row, "manual_resummarized", note, {}, { provider, model });
  const { error } = await supabase.from("articles").update({ source_metadata: sourceMetadata }).eq("id", row.id);
  if (error) throw new Error(error.message);
  const triageUpdated = await updateArticleTriageFields({
    articleId: row.id,
    errorClass: null,
    errorContext: null,
    reviewState: ARTICLE_REVIEW_STATE.MANUAL_RESUMMARIZED,
  });
  if (triageUpdated) {
    await shadowArticleLifecycleTransition({
      articleId: row.id,
      cohort: "review",
      actorType: "admin",
      source: "admin.review",
      reasonCode: "legacy.review.manual_resummary_recorded",
      processingState: "complete",
    });
  }
}

export async function runAdminReviewAction(input: ReviewActionInput) {
  const { supabase, row } = await findReviewArticle(input.articleId, input.slug);
  if (!supabase) {
    return { mode: "no-database", status: "skipped", reason: "Supabase 환경변수가 없어 검토 결정을 저장할 수 없습니다." };
  }
  if (!row) {
    return { mode: "database", status: "not_found", reason: "자료를 찾을 수 없습니다." };
  }

  if (input.action === "resummarize-with-model") {
    const model = input.model?.trim();
    const provider = normalizeProvider(input.provider, model);
    if (!isPublicSummarized(row)) {
      return {
        mode: "database",
        action: input.action,
        status: "skipped",
        reason: "이미 공개된 요약 자료만 모델을 선택해 재요약할 수 있습니다.",
      };
    }
    if (!model) {
      return {
        mode: "database",
        action: input.action,
        status: "skipped",
        reason: "재요약에 사용할 모델을 선택해야 합니다.",
      };
    }

    const summarize = await runSummarizeArticle({ articleId: row.id, provider, model, force: true });
    if (summarize.status === "summarized") {
      await recordManualResummary(row, provider, model, input.note);
    }

    return {
      mode: "database",
      action: input.action,
      provider,
      model,
      summarize,
    };
  }

  if (input.action === "retry-summary") {
    return {
      mode: "database",
      action: input.action,
      summarize: await runSummarizeArticle({ articleId: row.id }),
    };
  }

  if (input.action === "approve-and-summarize") {
    if (!hasPublishableCleanedText(row)) {
      return {
        mode: "database",
        action: input.action,
        status: "skipped",
        reason: `추출 본문이 ${MIN_PUBLISHABLE_TEXT_LENGTH}자 미만이라 요약 승인 전에 원문 수집을 다시 해야 합니다.`,
      };
    }
    await updateArticleForSummary(row, input.note);
    return {
      mode: "database",
      action: input.action,
      summarize: await runSummarizeArticle({ articleId: row.id }),
    };
  }

  if (input.action === "publish-reviewed") {
    return {
      mode: "database",
      action: input.action,
      ...(await publishReviewedArticle(row, input.note)),
    };
  }

  if (input.action === "close-private") {
    return {
      mode: "database",
      action: input.action,
      ...(await closePrivate(row, input.note)),
    };
  }

  return {
    mode: "database",
    action: input.action,
    ingest: await import("@/lib/ingest/run").then(({ runIngest }) => runIngest({ sourceKey: row.source_key, limit: 5 })),
  };
}
