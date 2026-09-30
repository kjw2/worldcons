import type { AdminJobType } from "@/lib/db/admin-jobs";
import { ingestResultSucceeded } from "@/lib/ingest/results";
import type { AdminIngestBody } from "@/lib/security/admin-api-validation";

export type AdminIngestJobType = Extract<AdminJobType, "ingest" | "ingest-and-summarize" | "summarize" | "retry-summary" | "refresh-tags">;
export const ADMIN_INGEST_JOB_TYPES: AdminIngestJobType[] = ["ingest", "ingest-and-summarize", "summarize", "retry-summary", "refresh-tags"];

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
  shouldSummarize: boolean;
  shouldIngest: boolean;
  shouldRefreshTags: boolean;
  requestedOptions: Record<string, unknown>;
  jobOptions: Record<string, unknown>;
  auditMetadata: Record<string, unknown>;
}

function supportedAction(value: string): value is AdminIngestJobType {
  return (ADMIN_INGEST_JOB_TYPES as string[]).includes(value);
}

export function buildAdminIngestJobContext(input: AdminIngestBody): AdminIngestRequestContext {
  const { action, sourceKey, articleId, slug, limit, rangeDays, refreshExisting } = input;
  if (!supportedAction(action)) throw new Error(`Unsupported admin ingest job action: ${action}`);
  const summarizeLimit = input.summarizeLimit ?? limit ?? 20;
  const shouldSummarize = action === "summarize" || action === "retry-summary" || action === "ingest-and-summarize" || input.summarize;
  const shouldIngest = action === "ingest" || action === "ingest-and-summarize";
  const shouldRefreshTags = action === "refresh-tags" || input.refreshTags || shouldSummarize;
  const jobOptions = {
    action, sourceKey: sourceKey ?? null, limit: limit ?? null, rangeDays: rangeDays ?? null,
    refreshExisting: refreshExisting ?? null, summarizeLimit, summarize: input.summarize,
    refreshTags: input.refreshTags, articleId: articleId ?? null, slug: slug ?? null,
  };
  return {
    action, requestedAction: action, sourceKey, articleId, slug, limit, rangeDays, refreshExisting,
    summarizeLimit, shouldSummarize, shouldIngest, shouldRefreshTags,
    requestedOptions: { requestedAction: action, ...jobOptions }, jobOptions,
    auditMetadata: {
      action, requestedAction: action, requestedSourceKey: sourceKey ?? null,
      requestedArticleId: articleId ?? null, requestedArticleSlug: slug ?? null,
      requestedLimit: limit ?? null, requestedSummarizeLimit: summarizeLimit,
      requestedSummarize: input.summarize, requestedRefreshTags: input.refreshTags,
      shouldSummarize, shouldIngest, shouldRefreshTags, result: "started",
    },
  };
}

export function validateAdminIngestJobContext(context: AdminIngestRequestContext) {
  if (context.action === "retry-summary" && !context.articleId && !context.slug) throw new Error("articleId or slug is required");
}

export function adminIngestResultSucceeded(value: unknown) { return ingestResultSucceeded(value); }
