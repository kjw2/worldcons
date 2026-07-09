import { getSupabaseAdmin } from "@/lib/db/client";
import { redactAdminAuditMetadata, redactAdminAuditText } from "@/lib/security/audit-redaction";

export const ARTICLE_ERROR_CLASS = {
  CRAWL_ROBOTS_DISALLOWED: "crawl.robots_disallowed",
  CRAWL_TIMEOUT_RESPONSE: "crawl.timeout_response",
  CRAWL_BLOCKED_403: "crawl.blocked_403",
  EXTRACT_EMPTY_TEXT: "extract.empty_text",
  SUMMARY_MODEL_ERROR: "summary.model_error",
  SUMMARY_RETRYABLE_QUOTA: "summary.retryable_quota",
  LLM_KEY_MISSING: "llm.key_missing",
  AUTH_CSRF_FAILED: "auth.csrf_failed",
  DB_QUERY_FAILED: "db.query_failed",
  JOB_STALE_RUNNING: "job.stale_running",
} as const;

export const ARTICLE_ERROR_CLASSES = Object.values(ARTICLE_ERROR_CLASS);
export type ArticleErrorClass = (typeof ARTICLE_ERROR_CLASSES)[number];

export const ARTICLE_REVIEW_STATE = {
  NEEDS_TRIAGE: "needs_triage",
  RETRY_LATER: "retry_later",
  APPROVED_FOR_SUMMARY: "approved_for_summary",
  PUBLISHED: "published",
  CLOSED_PRIVATE: "closed_private",
  MANUAL_SUMMARY_EDIT: "manual_summary_edit",
  MANUAL_RESUMMARIZED: "manual_resummarized",
  SUMMARIZED: "summarized",
} as const;

export const ARTICLE_REVIEW_STATES = Object.values(ARTICLE_REVIEW_STATE);
export type ArticleReviewState = (typeof ARTICLE_REVIEW_STATES)[number];

interface ArticleTriageUpdateInput {
  articleId?: string | null;
  articleIds?: string[];
  errorClass?: ArticleErrorClass | null;
  errorContext?: Record<string, unknown> | null;
  reviewState?: ArticleReviewState | null;
}

function logOptionalTriageFailure(error: unknown) {
  if (process.env.NODE_ENV === "production") return;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`article triage fields skipped: ${message}`);
}

export function classifySummaryError(message?: string | null, retryable = false): ArticleErrorClass {
  const lowered = message?.toLowerCase() ?? "";
  if (retryable || lowered.includes("quota") || lowered.includes("429") || lowered.includes("high demand")) {
    return ARTICLE_ERROR_CLASS.SUMMARY_RETRYABLE_QUOTA;
  }
  if (lowered.includes("api key") || lowered.includes("key missing") || lowered.includes("no gemini routes are locally available")) {
    return ARTICLE_ERROR_CLASS.LLM_KEY_MISSING;
  }
  return ARTICLE_ERROR_CLASS.SUMMARY_MODEL_ERROR;
}

export function classifyLlmError(error: unknown): ArticleErrorClass {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (
    lowered.includes("api key") ||
    lowered.includes("key is required") ||
    lowered.includes("key is not configured") ||
    lowered.includes("key missing") ||
    lowered.includes("no gemini api key") ||
    lowered.includes("no llm completion available")
  ) {
    return ARTICLE_ERROR_CLASS.LLM_KEY_MISSING;
  }
  if (
    lowered.includes("quota") ||
    lowered.includes("429") ||
    lowered.includes("rate limit") ||
    lowered.includes("rate_limit") ||
    lowered.includes("too many requests") ||
    lowered.includes("high demand")
  ) {
    return ARTICLE_ERROR_CLASS.SUMMARY_RETRYABLE_QUOTA;
  }
  return ARTICLE_ERROR_CLASS.SUMMARY_MODEL_ERROR;
}

export function fallbackErrorClassForArticleStatus(status?: string | null): ArticleErrorClass | null {
  if (status === "robots_disallowed") return ARTICLE_ERROR_CLASS.CRAWL_ROBOTS_DISALLOWED;
  if (status === "timeout") return ARTICLE_ERROR_CLASS.CRAWL_TIMEOUT_RESPONSE;
  if (status === "blocked") return ARTICLE_ERROR_CLASS.CRAWL_BLOCKED_403;
  if (status === "metadata_only") return ARTICLE_ERROR_CLASS.EXTRACT_EMPTY_TEXT;
  if (status === "failed_summary") return ARTICLE_ERROR_CLASS.SUMMARY_MODEL_ERROR;
  return null;
}

export function fallbackReviewStateForArticleStatus(status?: string | null): ArticleReviewState | null {
  if (status === "needs_review") return ARTICLE_REVIEW_STATE.NEEDS_TRIAGE;
  if (status === "failed_summary") return ARTICLE_REVIEW_STATE.NEEDS_TRIAGE;
  if (status === "summarizing") return ARTICLE_REVIEW_STATE.RETRY_LATER;
  return null;
}

export async function updateArticleTriageFields(input: ArticleTriageUpdateInput) {
  const supabase = getSupabaseAdmin();
  const ids = Array.from(new Set([...(input.articleIds ?? []), input.articleId].filter(Boolean) as string[]));
  if (!supabase || ids.length === 0) return;

  const update: Record<string, unknown> = {};
  if (input.errorClass !== undefined) update.error_class = input.errorClass;
  if (input.errorContext !== undefined) update.error_context = input.errorContext ? redactAdminAuditMetadata(input.errorContext) : null;
  if (input.reviewState !== undefined) update.review_state = input.reviewState ? redactAdminAuditText(input.reviewState, 80) : null;
  if (Object.keys(update).length === 0) return;

  try {
    const query = supabase.from("articles").update(update);
    const { error } = ids.length === 1 ? await query.eq("id", ids[0]) : await query.in("id", ids);
    if (error) logOptionalTriageFailure(error.message);
  } catch (error) {
    logOptionalTriageFailure(error);
  }
}
