import type { AdminJobType } from "@/lib/db/admin-jobs";
import { runRefreshTagCounts, runSummarizeArticle, runSummarizePending } from "@/lib/ingest/summary";
import { summaryBatchFailureMessage, summaryBatchHasHardFailure, summaryBatchWasDeferred } from "@/lib/ingest/summary-batch";
import { ingestResultSucceeded } from "@/lib/ingest/results";
import { invalidatePublicContentCaches } from "@/lib/public-content-cache";
import { redactAdminAuditMetadata } from "@/lib/security/audit-redaction";
import { parseAdminIngestBody, type AdminIngestBody } from "@/lib/security/admin-api-validation";

export type AdminIngestJobType = Extract<AdminJobType, "ingest" | "ingest-and-summarize" | "summarize" | "retry-summary" | "refresh-tags">;

export interface AdminIngestRequestContext {
  action: AdminIngestJobType;
  requestedAction: AdminIngestJobType;
  sourceKey?: string;
  articleId?: string;
  slug?: string;
  limit?: number;
  rangeDays?: number;
  refreshExisting?: boolean;
  summarizeLimit: number;
  allowVercelCrawling: boolean;
  shouldSummarize: boolean;
  shouldIngest: boolean;
  shouldRefreshTags: boolean;
  requestedOptions: Record<string, unknown>;
  jobOptions: Record<string, unknown>;
  auditMetadata: Record<string, unknown>;
}

export interface AdminIngestExecutionResult {
  ingest: unknown;
  summarize: unknown;
  tags: unknown;
  resultSummary: Record<string, unknown>;
}

export const ADMIN_INGEST_JOB_TYPES: AdminIngestJobType[] = ["ingest", "ingest-and-summarize", "summarize", "retry-summary", "refresh-tags"];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countFromResults(value: unknown, key: string) {
  if (!isRecord(value) || !Array.isArray(value.results)) return 0;
  return value.results.reduce((sum, item) => (isRecord(item) && typeof item[key] === "number" ? sum + item[key] : sum), 0);
}

function ingestResultSummary(value: unknown) {
  if (!isRecord(value)) return undefined;
  const mode = typeof value.mode === "string" ? value.mode : undefined;
  return {
    mode,
    sourceCount: Array.isArray(value.results) ? value.results.length : 0,
    discoveredCount: countFromResults(value, "discoveredCount"),
    fetchedCount: countFromResults(value, "fetchedCount"),
    summarizedCount: countFromResults(value, "summarizedCount"),
    failedCount: countFromResults(value, "failedCount"),
  };
}

function summarizeResultSummary(value: unknown) {
  if (!isRecord(value)) return undefined;
  return {
    mode: typeof value.mode === "string" ? value.mode : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    summarizedCount: typeof value.summarizedCount === "number" ? value.summarizedCount : 0,
    failedCount: typeof value.failedCount === "number" ? value.failedCount : 0,
    skippedCount: typeof value.skippedCount === "number" ? value.skippedCount : 0,
    deferredCount: typeof value.deferredCount === "number" ? value.deferredCount : 0,
    retryCount: typeof value.retryCount === "number" ? value.retryCount : 0,
    limitReached: value.limitReached === true,
    incomplete: summaryBatchWasDeferred(value) || summaryBatchHasHardFailure(value),
  };
}

function tagResultSummary(value: unknown) {
  if (!isRecord(value)) return undefined;
  return {
    refreshed: value.refreshed === true,
    updatedTags: typeof value.updatedTags === "number" ? value.updatedTags : undefined,
  };
}

function supportedAction(value: string): value is AdminIngestJobType {
  return (ADMIN_INGEST_JOB_TYPES as string[]).includes(value);
}

export function buildAdminIngestJobContext(input: AdminIngestBody): AdminIngestRequestContext {
  const { action, sourceKey, articleId, slug, limit, rangeDays, refreshExisting, allowVercelCrawling } = input;
  if (!supportedAction(action)) throw new Error(`Unsupported admin ingest job action: ${action}`);

  const requestedAction = action;
  const summarizeLimit = input.summarizeLimit ?? limit ?? 20;
  const shouldSummarize = action === "summarize" || action === "retry-summary" || action === "ingest-and-summarize" || input.summarize;
  const shouldIngest = action === "ingest" || action === "ingest-and-summarize";
  const shouldRefreshTags = action === "refresh-tags" || input.refreshTags || shouldSummarize;
  const jobOptions = {
    action,
    sourceKey: sourceKey ?? null,
    limit: limit ?? null,
    rangeDays: rangeDays ?? null,
    refreshExisting: refreshExisting ?? null,
    summarizeLimit,
    summarize: input.summarize,
    refreshTags: input.refreshTags,
    allowVercelCrawling,
    articleId: articleId ?? null,
    slug: slug ?? null,
  };
  const requestedOptions = {
    requestedAction,
    ...jobOptions,
  };
  const auditMetadata = {
    action,
    requestedAction,
    requestedSourceKey: sourceKey ?? null,
    requestedArticleId: articleId ?? null,
    requestedArticleSlug: slug ?? null,
    requestedLimit: limit ?? null,
    requestedSummarizeLimit: summarizeLimit,
    requestedSummarize: input.summarize,
    requestedRefreshTags: input.refreshTags,
    requestedAllowVercelCrawling: allowVercelCrawling,
    shouldSummarize,
    shouldIngest,
    shouldRefreshTags,
    result: "started",
  };

  return {
    action,
    requestedAction,
    sourceKey,
    articleId,
    slug,
    limit,
    rangeDays,
    refreshExisting,
    summarizeLimit,
    allowVercelCrawling,
    shouldSummarize,
    shouldIngest,
    shouldRefreshTags,
    requestedOptions,
    jobOptions,
    auditMetadata,
  };
}

export function buildAdminIngestJobContextFromOptions(options: Record<string, unknown>, fallbackAction?: string | null) {
  const action = typeof options.action === "string" && options.action.trim() ? options.action : fallbackAction;
  const parsed = parseAdminIngestBody({ ...options, action });
  if (!parsed.ok) throw new Error(`Invalid admin ingest job options: ${parsed.error}`);
  return buildAdminIngestJobContext(parsed.data);
}

export function validateAdminIngestJobContext(context: AdminIngestRequestContext) {
  if (context.action === "retry-summary" && !context.articleId && !context.slug) {
    throw new Error("articleId or slug is required");
  }
}

export function compactAdminIngestExecutionSummary(result: Pick<AdminIngestExecutionResult, "ingest" | "summarize" | "tags">) {
  return redactAdminAuditMetadata({
    ingest: ingestResultSummary(result.ingest),
    summarize: summarizeResultSummary(result.summarize),
    tags: tagResultSummary(result.tags),
  });
}

export function adminIngestResultSucceeded(value: unknown) {
  return ingestResultSucceeded(value);
}

export async function executeAdminIngestJobContext(context: AdminIngestRequestContext): Promise<AdminIngestExecutionResult> {
  validateAdminIngestJobContext(context);
  const { summarizeLimit, sourceKey } = context;
  const ingest = context.shouldIngest
    ? await import("@/lib/ingest/run").then(({ runIngest }) =>
        runIngest({
          sourceKey,
          limit: context.limit,
          rangeDays: context.rangeDays,
          refreshExisting: context.refreshExisting,
          allowVercelCrawling: context.allowVercelCrawling,
        }),
      )
    : null;
  if (isRecord(ingest) && ingest.mode === "blocked") {
    throw new Error(typeof ingest.message === "string" ? ingest.message : "Ingest is blocked in the current environment.");
  }
  const summarize = context.action === "retry-summary"
    ? await runSummarizeArticle({ articleId: context.articleId, slug: context.slug })
    : context.shouldSummarize
      ? await runSummarizePending({ limit: summarizeLimit, sourceKey })
      : null;
  const tags = context.shouldRefreshTags && context.action !== "retry-summary"
    ? await runRefreshTagCounts().catch((refreshError) => {
        if (context.action === "refresh-tags") throw refreshError;
        return { refreshed: false, errorMessage: errorMessage(refreshError) };
      })
    : null;
  const resultSummary = compactAdminIngestExecutionSummary({ ingest, summarize, tags });
  if (ingest !== null || summarize !== null || tags !== null) {
    invalidatePublicContentCaches({ articleSlug: context.slug });
  }
  if (summarize && (summaryBatchWasDeferred(summarize) || summaryBatchHasHardFailure(summarize))) {
    throw new Error(summaryBatchFailureMessage(summarize));
  }

  return { ingest, summarize, tags, resultSummary };
}

export async function executeAdminIngestJobOptions(options: Record<string, unknown>, fallbackAction?: string | null) {
  return executeAdminIngestJobContext(buildAdminIngestJobContextFromOptions(options, fallbackAction));
}
