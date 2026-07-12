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
  | { ok: false; anomalyCode: string };

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
  if (reviewState === "needs_triage" || reviewState === "retry_later") return reviewState;
  const metadata = isRecord(sourceMetadata) ? sourceMetadata : {};
  const current = nestedRecord(metadata, "review").decision;
  if (typeof current === "string" && AUTHORITATIVE_REVIEW_DECISIONS.has(current)) return current;
  if (reviewState && AUTHORITATIVE_REVIEW_DECISIONS.has(reviewState)) return reviewState;
  const history = Array.isArray(metadata.reviewHistory) ? metadata.reviewHistory : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    const decision = isRecord(entry) && typeof entry.decision === "string" ? entry.decision : null;
    if (decision && AUTHORITATIVE_REVIEW_DECISIONS.has(decision)) return decision;
  }
  return reviewState;
}

const LEGACY_STATUSES = new Set([
  "discovered", "metadata_only", "robots_disallowed", "blocked", "timeout", "fetched",
  "cleaned", "summarizing", "summarized", "failed_fetch", "failed_summary", "needs_review",
]);

export function mapLegacyArticleLifecycle(evidence: LegacyArticleLifecycleEvidence): LegacyArticleLifecycleMapping {
  const { status } = evidence;
  if (!LEGACY_STATUSES.has(status)) return { ok: false, anomalyCode: "backfill.unknown_legacy_status" };

  const collection = nestedRecord(evidence.sourceMetadata, "collection");
  const textAvailable = booleanSignal(collection.sourceTextAvailable);
  const publishable = booleanSignal(collection.publishable);
  const decision = effectiveReviewDecision(evidence.sourceMetadata, evidence.reviewState);

  if (collection.sourceTextAvailable !== undefined && textAvailable === null) {
    return { ok: false, anomalyCode: "backfill.invalid_source_text_signal" };
  }
  if (["discovered", "metadata_only", "robots_disallowed", "blocked", "timeout", "failed_fetch"].includes(status) && textAvailable === true) {
    return { ok: false, anomalyCode: "backfill.status_text_conflict" };
  }
  if (["cleaned", "summarizing", "summarized", "failed_summary"].includes(status) && textAvailable === false) {
    return { ok: false, anomalyCode: "backfill.status_text_conflict" };
  }
  if (status === "summarized" && !evidence.hasSummary) return { ok: false, anomalyCode: "backfill.summarized_without_summary" };
  if (status === "needs_review" && textAvailable === null) return { ok: false, anomalyCode: "backfill.needs_review_text_ambiguous" };
  if (status === "needs_review" && textAvailable === false && evidence.hasSummary) {
    return { ok: false, anomalyCode: "backfill.review_summary_text_conflict" };
  }
  if (["published", "approved"].includes(decision ?? "") && publishable !== true) {
    return { ok: false, anomalyCode: "backfill.approval_publishable_conflict" };
  }
  if (evidence.errorClass && !/^[a-z][a-z0-9._-]{0,119}$/.test(evidence.errorClass)) {
    return { ok: false, anomalyCode: "backfill.invalid_error_class" };
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

  let reviewState: ArticleLifecycleReviewState = "unreviewed";
  if (decision === "closed_private") reviewState = "closed_private";
  else if (decision === "published" || decision === "approved") reviewState = "approved";
  else if (decision === "approved_for_summary") reviewState = "approved_for_processing";
  else if (["needs_review", "needs_triage", "retry_later"].includes(decision ?? "") || status === "needs_review") reviewState = "needs_review";

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
