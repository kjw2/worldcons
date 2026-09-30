import {
  ADMIN_INGEST_JOB_TYPES,
  adminIngestResultSucceeded,
  buildAdminIngestJobContext,
  validateAdminIngestJobContext,
  type AdminIngestJobType,
  type AdminIngestRequestContext,
} from "@/lib/admin/admin-ingest-contract";
import { runRefreshTagCounts, runSummarizeArticle, runSummarizePending } from "@/lib/ingest/summary";
import { summaryBatchFailureMessage, summaryBatchHasHardFailure, summaryBatchWasDeferred } from "@/lib/ingest/summary-batch";
import { ingestResultSucceeded } from "@/lib/ingest/results";
import { invalidatePublicContentCaches } from "@/lib/public-content-cache";
import { redactAdminAuditMetadata } from "@/lib/security/audit-redaction";
import { parseAdminIngestBody, type AdminIngestBody } from "@/lib/security/admin-api-validation";

export { ADMIN_INGEST_JOB_TYPES, adminIngestResultSucceeded, buildAdminIngestJobContext } from "@/lib/admin/admin-ingest-contract";
export type { AdminIngestJobType, AdminIngestRequestContext } from "@/lib/admin/admin-ingest-contract";

export interface AdminIngestExecutionResult {
  ingest: unknown;
  summarize: unknown;
  tags: unknown;
  resultSummary: Record<string, unknown>;
}

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

export function buildAdminIngestJobContextFromOptions(options: Record<string, unknown>, fallbackAction?: string | null) {
  const action = typeof options.action === "string" && options.action.trim() ? options.action : fallbackAction;
  const parsed = parseAdminIngestBody({ ...options, action });
  if (!parsed.ok) throw new Error(`Invalid admin ingest job options: ${parsed.error}`);
  return buildAdminIngestJobContext(parsed.data);
}

export function compactAdminIngestExecutionSummary(result: Pick<AdminIngestExecutionResult, "ingest" | "summarize" | "tags">) {
  return redactAdminAuditMetadata({
    ingest: ingestResultSummary(result.ingest),
    summarize: summarizeResultSummary(result.summarize),
    tags: tagResultSummary(result.tags),
  });
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
