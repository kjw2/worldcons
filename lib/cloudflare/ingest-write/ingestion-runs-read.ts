import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";

/**
 * D1-native readers for the legacy incremental collections' `ingestion_runs`
 * checkpoint. Supabase was retired at the M13 cutover, so the previous
 * Supabase-only loader always returned empty and the incremental range floor
 * was used forever. Reads here are bounded and additive (no write).
 */

export interface SourceCollectionCheckpoint {
  lastSuccessfulRunAt?: string;
  lastVerifiedPublishedAt?: string;
}

interface IngestionRunMetadataRow {
  finished_at: string | null;
  started_at: string | null;
  metadata: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numericMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function ensureRows<T>(result: { success?: boolean; error?: string | null; results?: T[] }): T[] {
  if (result.success === false || result.error) throw new Error("ingestion_runs.query_failed");
  return result.results ?? [];
}

async function recentCompletedRuns(db: D1RuntimeDatabase, sourceKey: string, limit: number) {
  return ensureRows(
    await db
      .prepare(
        `SELECT finished_at, started_at, metadata FROM ingestion_runs
          WHERE source_key = ? AND status = 'completed'
          ORDER BY finished_at IS NULL, finished_at DESC, started_at DESC
          LIMIT ?`,
      )
      .bind(sourceKey, limit)
      .all<IngestionRunMetadataRow>(),
  );
}

/** The latest completed run time and most recent verified publication anchor. */
export async function readSourceCollectionCheckpoint(
  db: D1RuntimeDatabase,
  sourceKey: string,
): Promise<SourceCollectionCheckpoint> {
  const runs = await recentCompletedRuns(db, sourceKey, 8);
  const latest = runs[0];
  const lastSuccessfulRunAt = stringValue(latest?.finished_at) ?? stringValue(latest?.started_at) ?? undefined;
  for (const run of runs) {
    const verifiedAt = stringValue(parseMetadata(run.metadata).lastVerifiedPublishedAt);
    if (verifiedAt) return { lastSuccessfulRunAt, lastVerifiedPublishedAt: verifiedAt };
  }
  return { lastSuccessfulRunAt };
}

/**
 * True when the two most recent completed Spanish runs both observed pending
 * rechecks but promoted none. Uses the same bounded, newest-first query as the
 * legacy loader, now against D1.
 */
export async function isSpainPendingPromotionStale(
  db: D1RuntimeDatabase,
  input: { sourceKey: string; pendingRecheckCount: number; promotedCount: number },
): Promise<boolean> {
  if (input.pendingRecheckCount === 0 || input.promotedCount > 0) return false;
  const recent = await recentCompletedRuns(db, input.sourceKey, 2);
  if (recent.length < 2) return false;
  return recent.every((row) => {
    const metadata = parseMetadata(row.metadata);
    return numericMetadata(metadata.pendingRecheckCount) > 0 && numericMetadata(metadata.spainSourceTextPromotedCount) === 0;
  });
}
