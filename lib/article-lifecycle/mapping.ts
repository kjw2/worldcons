import type { ArticleStatus } from "@/lib/db/types";
import type {
  ArticleAttentionSeverity,
  ArticleAttentionSource,
  ArticleCollectionState,
  ArticleLifecycleReviewState,
  ArticleProcessingState,
} from "@/lib/article-lifecycle/types";

export interface LegacyArticleLifecycleEvidence {
  status: ArticleStatus | string;
  sourceMetadata?: unknown;
  reviewState?: string | null;
  errorClass?: string | null;
  errorContext?: unknown;
  hasSummary?: boolean;
}

export interface MappedArticleLifecycle {
  collectionState: ArticleCollectionState;
  processingState: ArticleProcessingState;
  reviewState: ArticleLifecycleReviewState;
  attention: { operation: "keep" } | {
    operation: "raise";
    code: string;
    retryable: boolean;
    severity: ArticleAttentionSeverity;
    source: ArticleAttentionSource;
  };
}

export type LegacyArticleLifecycleMapping =
  | { ok: true; state: MappedArticleLifecycle }
  | { ok: false; anomalyCode: string; reviewState?: ArticleLifecycleReviewState };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedRecord(value: unknown, key: string) {
  return isRecord(value) && isRecord(value[key]) ? value[key] as Record<string, unknown> : {};
}

function booleanSignal(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function errorAttention(code: string, errorContext: unknown) {
  const context = isRecord(errorContext) ? errorContext : {};
  const retryable = typeof context.retryable === "boolean"
    ? context.retryable
    : !["crawl.robots_disallowed", "llm.key_missing"].includes(code);
  const severity: ArticleAttentionSeverity = code === "crawl.robots_disallowed" || code === "collection.metadata_only"
    ? "low"
    : /^(summary|llm|job)\./.test(code) ? "high" : "medium";
  const source: ArticleAttentionSource = /^(summary|llm|job)\./.test(code) ? "processing" : "collection";
  return { operation: "raise" as const, code, retryable, severity, source };
}

const AUTHORITATIVE_REVIEW_DECISIONS = new Set([
  "closed_private", "published", "approved", "approved_for_summary", "needs_review",
]);

function effectiveReviewDecision(sourceMetadata: unknown, reviewState?: string | null) {
  const metadata = isRecord(sourceMetadata) ? sourceMetadata : {};
  const current = nestedRecord(metadata, "review").decision;
  if (typeof current === "string" && AUTHORITATIVE_REVIEW_DECISIONS.has(current)) return current;
  if (reviewState === "needs_triage" || reviewState === "retry_later") return reviewState;
  if (reviewState && AUTHORITATIVE_REVIEW_DECISIONS.has(reviewState)) return reviewState;
  const history = Array.isArray(metadata.reviewHistory) ? metadata.reviewHistory : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    const decision = isRecord(entry) && typeof entry.decision === "string" ? entry.decision : null;
    if (decision && AUTHORITATIVE_REVIEW_DECISIONS.has(decision)) return decision;
  }
  return reviewState;
}

function lifecycleReviewState(decision: string | null | undefined, status: string): ArticleLifecycleReviewState {
  if (decision === "closed_private") return "closed_private";
  if (decision === "published" || decision === "approved") return "approved";
  if (decision === "approved_for_summary") return "approved_for_processing";
  if (["needs_review", "needs_triage", "retry_later"].includes(decision ?? "") || status === "needs_review") return "needs_review";
  return "unreviewed";
}

const LEGACY_STATUSES = new Set([
  "discovered", "metadata_only", "robots_disallowed", "blocked", "timeout", "fetched",
  "cleaned", "summarizing", "summarized", "failed_fetch", "failed_summary", "needs_review",
]);

export function mapLegacyArticleLifecycle(evidence: LegacyArticleLifecycleEvidence): LegacyArticleLifecycleMapping {
  const { status } = evidence;
  const collection = nestedRecord(evidence.sourceMetadata, "collection");
  const textAvailable = booleanSignal(collection.sourceTextAvailable);
  const publishable = booleanSignal(collection.publishable);
  const decision = effectiveReviewDecision(evidence.sourceMetadata, evidence.reviewState);
  const reviewState = lifecycleReviewState(decision, status);
  const anomaly = (anomalyCode: string): LegacyArticleLifecycleMapping => ({
    ok: false,
    anomalyCode,
    ...(reviewState === "unreviewed" ? {} : { reviewState }),
  });

  if (!LEGACY_STATUSES.has(status)) return anomaly("backfill.unknown_legacy_status");

  if (collection.sourceTextAvailable !== undefined && textAvailable === null) {
    return anomaly("backfill.invalid_source_text_signal");
  }
  if (["discovered", "metadata_only", "robots_disallowed", "blocked", "timeout", "failed_fetch"].includes(status) && textAvailable === true) {
    return anomaly("backfill.status_text_conflict");
  }
  if (["cleaned", "summarizing", "summarized", "failed_summary"].includes(status) && textAvailable === false) {
    return anomaly("backfill.status_text_conflict");
  }
  if (status === "summarized" && !evidence.hasSummary) return anomaly("backfill.summarized_without_summary");
  if (status === "needs_review" && textAvailable === null) return anomaly("backfill.needs_review_text_ambiguous");
  if (status === "needs_review" && textAvailable === false && evidence.hasSummary) {
    return anomaly("backfill.review_summary_text_conflict");
  }
  if (["published", "approved"].includes(decision ?? "") && publishable !== true) {
    return anomaly("backfill.approval_publishable_conflict");
  }
  if (evidence.errorClass && !/^[a-z][a-z0-9._-]{0,119}$/.test(evidence.errorClass)) {
    return anomaly("backfill.invalid_error_class");
  }

  let collectionState: ArticleCollectionState;
  if (status === "discovered") collectionState = "discovered";
  else if (["metadata_only", "robots_disallowed", "blocked", "timeout", "failed_fetch"].includes(status)) collectionState = "metadata_only";
  else if (status === "fetched") collectionState = "source_fetched";
  else if (status === "needs_review") collectionState = textAvailable ? "source_text_ready" : "metadata_only";
  else collectionState = "source_text_ready";

  let processingState: ArticleProcessingState = "not_ready";
  if (status === "cleaned" || status === "failed_summary") processingState = "ready";
  else if (status === "summarizing") processingState = "running";
  else if (status === "summarized") processingState = "complete";
  else if (status === "needs_review" && evidence.hasSummary) processingState = "complete";
  else if (status === "needs_review" && collectionState === "source_text_ready") processingState = "ready";

  const fallbackError = evidence.errorClass ?? ({
    metadata_only: "collection.metadata_only",
    robots_disallowed: "crawl.robots_disallowed",
    blocked: "crawl.blocked",
    timeout: "crawl.timeout",
    failed_fetch: "crawl.fetch_failed",
    failed_summary: "summary.failed",
  } as Record<string, string>)[status];

  return {
    ok: true,
    state: {
      collectionState,
      processingState,
      reviewState,
      attention: fallbackError ? errorAttention(fallbackError, evidence.errorContext) : { operation: "keep" },
    },
  };
}
