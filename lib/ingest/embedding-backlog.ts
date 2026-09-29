import {
  createEmbeddingArtifact,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "@/lib/ai/embeddings";
import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import type { SummaryJson } from "@/lib/db/types";
import { persistArticleEmbedding } from "@/lib/ingest/embedding-store";
import { isGlobalSummaryBackoff, summaryRetryDelayMs } from "@/lib/ingest/summary-batch";

export interface EmbeddingBacklogOptions {
  limit?: number;
  sourceKey?: string;
  delayMs?: number;
  signal?: AbortSignal;
  apiKeys?: string[];
  model?: string;
  provider?: string;
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
  const summary = candidate.summary;
  return typeof candidate.koreanTitle === "string"
    && typeof summary === "object"
    && summary !== null
    && Array.isArray(summary.coreSummary)
    && summary.coreSummary.every((item) => typeof item === "string")
    && typeof summary.background === "string"
    && typeof summary.implications === "string"
    && Array.isArray(candidate.tags)
    && candidate.tags.every((item) => typeof item === "string")
    && Array.isArray(candidate.entities)
    && candidate.entities.every((item) => typeof item === "object" && item !== null
      && typeof item.type === "string" && typeof item.normalizedName === "string");
}

function parseSummaryJson(value: unknown): SummaryJson | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isSummaryJson(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isSummaryJson(value) ? value : null;
}

function candidatePredicate() {
  return [
    "embedding_provider IS NULL",
    "embedding_provider != 'gemini'",
    "embedding_model IS NULL",
    `embedding_model != '${DEFAULT_GEMINI_EMBEDDING_MODEL}'`,
    "embedding_dimensions IS NULL",
    `embedding_dimensions != ${EMBEDDING_DIMENSIONS}`,
    "embedding_input_hash IS NULL",
  ].join(" OR ");
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
 * provenance-locked write updates the article and its currently matching
 * published P3 derived artifact, so a partial run is safe to repeat.
 */
export async function runEmbeddingBacklog(options: EmbeddingBacklogOptions = {}): Promise<EmbeddingBacklogResult> {
  const core = getRuntimeD1Binding("worldcons_core");
  if (!core) {
    return { status: "unavailable", scanned: 0, embedded: 0, skipped: 0, failed: 0, stoppedReason: "D1 core binding is not configured." };
  }

  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const delayMs = Math.max(0, options.delayMs ?? 0);
  const values: unknown[] = [];
  let query = `SELECT id, source_key, summary_json FROM articles WHERE status = 'summarized' AND (${candidatePredicate()})`;
  if (options.sourceKey) {
    query += " AND source_key = ?";
    values.push(options.sourceKey);
  }
  query += " ORDER BY created_at ASC LIMIT ?";
  values.push(limit);

  let result;
  try {
    result = await core.prepare(query).bind(...values).all<BacklogRow>();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "unavailable", scanned: 0, embedded: 0, skipped: 0, failed: 0, stoppedReason: `Failed to read embedding backlog: ${message}` };
  }
  if (result.success === false || result.error) {
    return { status: "unavailable", scanned: 0, embedded: 0, skipped: 0, failed: 0, stoppedReason: `Failed to read embedding backlog: ${result.error ?? "D1 query failed"}` };
  }

  const rows = result.results ?? [];
  let embedded = 0;
  let skipped = 0;
  let failed = 0;

  for (const [index, row] of rows.entries()) {
    if (options.signal?.aborted) throw options.signal.reason;

    const summary = parseSummaryJson(row.summary_json);
    if (!summary) {
      skipped += 1;
      continue;
    }

    try {
      const artifact = await createEmbeddingArtifact(summary, {
        signal: options.signal,
        apiKeys: options.apiKeys,
        model: options.model,
        provider: options.provider,
      });
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
  const core = getRuntimeD1Binding("worldcons_core");
  if (!core) return null;
  const values: unknown[] = [];
  let query = `SELECT COUNT(*) AS count FROM articles WHERE status = 'summarized' AND (${candidatePredicate()})`;
  if (sourceKey) {
    query += " AND source_key = ?";
    values.push(sourceKey);
  }
  try {
    const result = await core.prepare(query).bind(...values).all<{ count: number | string }>();
    if (result.success === false || result.error) return null;
    const count = Number(result.results?.[0]?.count);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
  } catch {
    return null;
  }
}

export interface EmbeddingReadiness {
  missingArticleCount: number;
  publishedVersionCount: number;
  missingPublishedArtifactCount: number;
}

export async function getEmbeddingReadiness(): Promise<EmbeddingReadiness | null> {
  const core = getRuntimeD1Binding("worldcons_core");
  if (!core) return null;
  try {
    const result = await core.prepare([
      "SELECT",
      `(SELECT COUNT(*) FROM articles a WHERE a.status = 'summarized' AND (${candidatePredicate()})) AS missingArticleCount,`,
      "(SELECT COUNT(*) FROM article_publications_p3 p WHERE p.state = 'published') AS publishedVersionCount,",
      "(SELECT COUNT(*) FROM article_publications_p3 p",
      "JOIN article_content_versions_p3 v ON v.id = p.version_id AND v.article_id = p.article_id",
      "WHERE p.state = 'published' AND NOT EXISTS (",
      "SELECT 1 FROM article_embedding_artifacts e",
      "WHERE e.article_version_id = v.id AND e.article_id = v.article_id AND e.content_hash = v.content_hash",
      "AND e.provider = 'gemini' AND e.model = ? AND e.dimensions = ?)) AS missingPublishedArtifactCount",
    ].join(" ")).bind(DEFAULT_GEMINI_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS).all<EmbeddingReadiness>();
    if (result.success === false || result.error) return null;
    const row = result.results?.[0];
    if (!row) return null;
    const number = (value: unknown) => {
      const parsed = typeof value === "number" ? value : Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
    };
    const missingArticleCount = number(row.missingArticleCount);
    const publishedVersionCount = number(row.publishedVersionCount);
    const missingPublishedArtifactCount = number(row.missingPublishedArtifactCount);
    if (missingArticleCount === null || publishedVersionCount === null || missingPublishedArtifactCount === null) return null;
    return { missingArticleCount, publishedVersionCount, missingPublishedArtifactCount };
  } catch {
    return null;
  }
}
