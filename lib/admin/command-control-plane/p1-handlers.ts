import { z } from "zod";
import { adminIngestResultSucceeded } from "@/lib/admin/admin-ingest-jobs";
import type { AdminQueueP1CommandType } from "@/lib/admin/command-control-plane/p1-authority";
import { executeExactCandidateRetry } from "@/lib/ingest/candidate-retry";
import {
  summaryBatchHasHardFailure,
  summaryBatchNeedsFollowUp,
  summaryBatchWasDeferred,
} from "@/lib/ingest/summary-batch";
import { runRefreshTagCounts, runSummarizePending } from "@/lib/ingest/summary";
import { runIngest } from "@/lib/ingest/run";

const cohortSchema = z.enum(["daily", "candidate-retry", "manual"]);
const sourceKeySchema = z.enum([
  "de-bverfg",
  "us-scotus",
  "fr-conseil-constitutionnel",
  "es-tribunal-constitucional",
]);

const collectSchema = z.object({
  cohort: cohortSchema,
  sourceKey: sourceKeySchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
  rangeDays: z.number().int().min(1).max(730).default(14),
  strategy: z.enum(["auto", "api", "cheerio", "playwright", "sitemap", "seed"]).default("auto"),
  usePlaywright: z.boolean().default(true),
  refreshExisting: z.boolean().default(true),
}).strict();

const summarizeSchema = z.object({
  cohort: cohortSchema,
  sourceKey: sourceKeySchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
  maxPasses: z.number().int().min(1).max(8).default(4),
}).strict();

const candidateSchema = z.object({ cohort: cohortSchema, candidateId: z.string().uuid() }).strict();
const scopeSchema = z.object({ cohort: cohortSchema, scope: z.literal("all").default("all") }).strict();

export class AdminP1HandlerError extends Error {
  constructor(
    readonly code: string,
    readonly disposition: "retryable" | "terminal",
  ) {
    super(code);
    this.name = "AdminP1HandlerError";
  }
}

export interface AdminP1HandlerContext {
  checkpoint: () => Promise<void>;
}

export type AdminP1CommandHandler = (
  payloadRef: Record<string, unknown>,
  context: AdminP1HandlerContext,
) => Promise<Record<string, unknown>>;

export interface AdminP1HandlerDependencies {
  runIngest: typeof runIngest;
  runSummarizePending: typeof runSummarizePending;
  runRefreshTagCounts: typeof runRefreshTagCounts;
  executeExactCandidateRetry: typeof executeExactCandidateRetry;
  revalidatePublicCaches: () => Promise<{ revalidated: boolean; statusCode: number }>;
}

async function revalidatePublicCaches() {
  const secret = process.env.CRON_SECRET?.trim();
  const baseUrl = (process.env.WORLDCONS_BASE_URL || process.env.APP_BASE_URL || "https://worldcons.vercel.app").trim();
  if (!secret || !baseUrl) throw new AdminP1HandlerError("cache.configuration_missing", "terminal");
  let endpoint: URL;
  try {
    endpoint = new URL("/api/admin/public-content/revalidate", baseUrl);
  } catch {
    throw new AdminP1HandlerError("cache.configuration_invalid", "terminal");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new AdminP1HandlerError(
      response.status === 429 || response.status >= 500 ? "cache.upstream_unavailable" : "cache.revalidation_rejected",
      response.status === 429 || response.status >= 500 ? "retryable" : "terminal",
    );
  }
  return { revalidated: true, statusCode: response.status };
}

const defaultDependencies: AdminP1HandlerDependencies = {
  runIngest,
  runSummarizePending,
  runRefreshTagCounts,
  executeExactCandidateRetry,
  revalidatePublicCaches,
};

function invalidPayload(): never {
  throw new AdminP1HandlerError("command.invalid_payload", "terminal");
}

function parsePayload<Schema extends z.ZodTypeAny>(schema: Schema, payloadRef: Record<string, unknown>): z.output<Schema> {
  const parsed = schema.safeParse(payloadRef);
  return parsed.success ? parsed.data as z.output<Schema> : invalidPayload();
}

export function createAdminP1CommandHandlers(
  dependencies: AdminP1HandlerDependencies = defaultDependencies,
): Record<AdminQueueP1CommandType, AdminP1CommandHandler> {
  return {
    "p1.collect": async (payloadRef, context) => {
      const payload = parsePayload(collectSchema, payloadRef);
      await context.checkpoint();
      const result = await dependencies.runIngest({
        sourceKey: payload.sourceKey,
        limit: payload.limit,
        strategy: payload.strategy,
        usePlaywright: payload.usePlaywright,
        rangeDays: payload.rangeDays,
        refreshExisting: payload.refreshExisting,
      });
      await context.checkpoint();
      if (!adminIngestResultSucceeded(result)) throw new AdminP1HandlerError("collect.incomplete", "retryable");
      const rows = result.results;
      return {
        sourceCount: rows.length,
        discoveredCount: rows.reduce((sum, row) => sum + row.discoveredCount, 0),
        fetchedCount: rows.reduce((sum, row) => sum + row.fetchedCount, 0),
        failedCount: rows.reduce((sum, row) => sum + row.failedCount, 0),
      };
    },

    "p1.summarize": async (payloadRef, context) => {
      const payload = parsePayload(summarizeSchema, payloadRef);
      let summarizedCount = 0;
      let failedCount = 0;
      let deferredCount = 0;
      let passes = 0;
      let needsFollowUp = false;
      for (let pass = 1; pass <= payload.maxPasses; pass += 1) {
        await context.checkpoint();
        const result = await dependencies.runSummarizePending({ limit: payload.limit, sourceKey: payload.sourceKey });
        await context.checkpoint();
        passes = pass;
        summarizedCount += result.summarizedCount;
        failedCount += result.failedCount;
        deferredCount += result.deferredCount;
        if (summaryBatchHasHardFailure(result)) throw new AdminP1HandlerError("summary.terminal_failure", "terminal");
        if (summaryBatchWasDeferred(result)) throw new AdminP1HandlerError("summary.rate_limited", "retryable");
        needsFollowUp = summaryBatchNeedsFollowUp(result);
        if (!needsFollowUp) break;
      }
      if (needsFollowUp) throw new AdminP1HandlerError("summary.drain_incomplete", "retryable");
      return { passes, summarizedCount, failedCount, deferredCount };
    },

    "p1.candidate.retry": async (payloadRef, context) => {
      const payload = parsePayload(candidateSchema, payloadRef);
      const result = await dependencies.executeExactCandidateRetry({
        candidateId: payload.candidateId,
        checkpoint: context.checkpoint,
      });
      return {
        candidateId: result.candidateId,
        status: result.status,
        attempted: result.attempted,
        idempotent: result.idempotent,
      };
    },

    "p1.refresh-derived": async (payloadRef, context) => {
      parsePayload(scopeSchema, payloadRef);
      await context.checkpoint();
      const result = await dependencies.runRefreshTagCounts();
      await context.checkpoint();
      if (!result.refreshed) throw new AdminP1HandlerError("derived.refresh_failed", "retryable");
      return { refreshed: true, updatedTags: result.updatedTags };
    },

    "p1.public-cache.revalidate": async (payloadRef, context) => {
      parsePayload(scopeSchema, payloadRef);
      await context.checkpoint();
      const result = await dependencies.revalidatePublicCaches();
      await context.checkpoint();
      if (!result.revalidated) throw new AdminP1HandlerError("cache.revalidation_failed", "retryable");
      return { revalidated: true, statusCode: result.statusCode };
    },
  };
}
