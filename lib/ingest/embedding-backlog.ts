import {
  createEmbeddingArtifact,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "@/lib/ai/embeddings";
import { getSupabaseAdmin, getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import type { SummaryJson } from "@/lib/db/types";
import { persistArticleEmbedding } from "@/lib/ingest/embedding-store";
import { isGlobalSummaryBackoff, summaryRetryDelayMs } from "@/lib/ingest/summary-batch";

export interface EmbeddingBacklogOptions {
  limit?: number;
  sourceKey?: string;
  delayMs?: number;
  signal?: AbortSignal;
}

export interface EmbeddingBacklogResult {
  status: "completed" | "deferred" | "unavailable";
  scanned: number;
  embedded: number;
  skipped: number;
  failed: number;
  stoppedReason?: string;
}

interface BacklogRow {
  id: string;
  source_key: string | null;
  summary_json: unknown;
}

function isSummaryJson(value: unknown): value is SummaryJson {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SummaryJson>;
  return typeof candidate.koreanTitle === "string" && typeof candidate.summary === "object" && candidate.summary !== null;
}

function wait(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/**
 * Fills missing or non-Gemini embeddings. Summary text is left untouched and the
 * provenance-locked RPC updates both the article and its published P3 derived
 * artifact, so a partial run is safe to repeat.
 */
export async function runEmbeddingBacklog(options: EmbeddingBacklogOptions = {}): Promise<EmbeddingBacklogResult> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return { status: "unavailable", scanned: 0, embedded: 0, skipped: 0, failed: 0, stoppedReason: "Supabase is not configured." };
  }

  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const delayMs = Math.max(0, options.delayMs ?? 0);

  let query = supabase
    .from("articles")
    .select("id, source_key, summary_json")
    .eq("status", "summarized")
    .or([
      "embedding.is.null",
      "embedding_provider.is.null",
      "embedding_provider.neq.gemini",
      "embedding_model.is.null",
      `embedding_model.neq.${DEFAULT_GEMINI_EMBEDDING_MODEL}`,
      "embedding_dimensions.is.null",
      `embedding_dimensions.neq.${EMBEDDING_DIMENSIONS}`,
      "embedding_input_hash.is.null",
    ].join(","))
    .order("created_at", { ascending: true })
    .limit(limit);
  if (options.sourceKey) query = query.eq("source_key", options.sourceKey);

  const { data, error } = await query;
  if (error) {
    return { status: "unavailable", scanned: 0, embedded: 0, skipped: 0, failed: 0, stoppedReason: `Failed to read embedding backlog: ${error.message}` };
  }

  const rows = (data ?? []) as BacklogRow[];
  let embedded = 0;
  let skipped = 0;
  let failed = 0;

  for (const [index, row] of rows.entries()) {
    if (options.signal?.aborted) throw options.signal.reason;

    if (!isSummaryJson(row.summary_json)) {
      // Without a usable summary there is nothing meaningful to embed; leave the row for review.
      skipped += 1;
      continue;
    }

    try {
      const artifact = await createEmbeddingArtifact(row.summary_json, { signal: options.signal });
      if (!artifact) {
        skipped += 1;
        continue;
      }

      if (artifact.vector.length !== EMBEDDING_DIMENSIONS) {
        return {
          status: "deferred",
          scanned: index + 1,
          embedded,
          skipped,
          failed: failed + 1,
          stoppedReason: `Embedding provider returned ${artifact.vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}.`,
        };
      }

      await persistArticleEmbedding(row.id, artifact);
      embedded += 1;
    } catch (caught) {
      if (options.signal?.aborted) throw options.signal.reason;
      const message = caught instanceof Error ? caught.message : String(caught);

      // Provider quota is a pause, not a failure: stop cleanly so the next run resumes.
      if (isGlobalSummaryBackoff(message)) {
        return {
          status: "deferred",
          scanned: index + 1,
          embedded,
          skipped,
          failed,
          stoppedReason: `Embedding provider deferred after ${embedded} vectors: ${message.slice(0, 300)}`,
        };
      }

      failed += 1;
      if (failed >= 5) {
        return {
          status: "deferred",
          scanned: index + 1,
          embedded,
          skipped,
          failed,
          stoppedReason: `Stopped after ${failed} consecutive embedding failures: ${message.slice(0, 300)}`,
        };
      }
      await wait(summaryRetryDelayMs(message, 0, 2_000), options.signal).catch(() => undefined);
      continue;
    }

    if (delayMs > 0 && index < rows.length - 1) {
      await wait(delayMs, options.signal);
    }
  }

  return { status: "completed", scanned: rows.length, embedded, skipped, failed };
}

export async function countMissingEmbeddings(sourceKey?: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  let query = supabase
    .from("articles")
    .select("id", { count: "exact", head: true })
    .eq("status", "summarized")
    .or([
      "embedding.is.null",
      "embedding_provider.is.null",
      "embedding_provider.neq.gemini",
      "embedding_model.is.null",
      `embedding_model.neq.${DEFAULT_GEMINI_EMBEDDING_MODEL}`,
      "embedding_dimensions.is.null",
      `embedding_dimensions.neq.${EMBEDDING_DIMENSIONS}`,
      "embedding_input_hash.is.null",
    ].join(","));
  if (sourceKey) query = query.eq("source_key", sourceKey);

  const { count, error } = await query;
  return error ? null : count ?? 0;
}

export interface EmbeddingReadiness {
  missingArticleCount: number;
  publishedVersionCount: number;
  missingPublishedArtifactCount: number;
}

export async function getEmbeddingReadiness(): Promise<EmbeddingReadiness | null> {
  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("article_embedding_readiness_v1");
  if (error || typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  const number = (value: unknown) => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
  };
  const missingArticleCount = number(row.missingArticleCount);
  const publishedVersionCount = number(row.publishedVersionCount);
  const missingPublishedArtifactCount = number(row.missingPublishedArtifactCount);
  if (missingArticleCount === null || publishedVersionCount === null || missingPublishedArtifactCount === null) return null;
  return { missingArticleCount, publishedVersionCount, missingPublishedArtifactCount };
}
