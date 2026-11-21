import { getRuntimeD1Binding, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";

export const STAGED_COLLECTION_SOURCES = [
  "de-bverfg",
  "es-tribunal-constitucional",
  "fr-conseil-constitutionnel",
] as const;

export interface StagedDiscoveryRun {
  id: string;
  sourceKey: string;
  status: string;
  startedAt: string;
  updatedAt: string;
}

export interface StagedSourceStatus {
  sourceKey: string;
  latestDiscovery: StagedDiscoveryRun | null;
  latestFollowup: { stage: string; status: string; updatedAt: string } | null;
  /** Dead-lettered post-crawl stage jobs currently observable for this source. */
  downstreamDeadLetterCount: number;
}

/**
 * Operational counters that the minute reservation tick also logs. They are
 * best-effort and additive: a missing optional table yields null, never an
 * unavailable snapshot.
 */
export interface StagedCollectionObservability {
  discoveryPendingCount: number | null;
  oldestDiscoveryPendingAgeSeconds: number | null;
  redriveRateLimitedLastHour: number | null;
  dispatchOutboxDeadLetters: number | null;
  bridgeOutboxDeadLetters: number | null;
}

export type StagedCollectionSnapshot =
  | {
      available: true;
      sources: StagedSourceStatus[];
      recentDiscoveries: StagedDiscoveryRun[];
      observability: StagedCollectionObservability;
    }
  | { available: false; reason: string };

interface DiscoveryRow {
  id: string;
  source_key: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface FollowupRow {
  source_key: string;
  stage: string;
  status: string;
  updated_at: string;
  count?: number | string;
}

interface CountRow {
  count?: number | string;
  oldest?: string | null;
}

async function optionalCount(db: D1RuntimeDatabase, sql: string, bind?: unknown): Promise<number | null> {
  try {
    const response = bind === undefined
      ? await db.prepare(sql).all<CountRow>()
      : await db.prepare(sql).bind(bind).all<CountRow>();
    if (response.success === false || response.error || !Array.isArray(response.results)) return null;
    const value = response.results[0]?.count;
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
  } catch {
    return null;
  }
}

async function checkedRows<T>(db: D1RuntimeDatabase, sql: string): Promise<T[]> {
  const response = await db.prepare(sql).all<T>();
  if (response.success === false || response.error || !Array.isArray(response.results)) {
    throw new Error("collection_status.d1_query_failed");
  }
  return response.results;
}

async function optionalFirst(db: D1RuntimeDatabase, sql: string, bind?: unknown): Promise<CountRow | null> {
  try {
    const response = bind === undefined
      ? await db.prepare(sql).all<CountRow>()
      : await db.prepare(sql).bind(bind).all<CountRow>();
    if (response.success === false || response.error || !Array.isArray(response.results)) return null;
    return response.results[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort operational counters for the staged pipeline. Every query is
 * bounded or aggregate-only, and a missing table/column yields null rather
 * than hiding the whole status snapshot.
 */
async function readObservability(db: D1RuntimeDatabase): Promise<StagedCollectionObservability> {
  const windowStart = new Date(Date.now() - 3_600_000).toISOString();
  const [pending, rateLimited, dispatchDead, bridgeDead] = await Promise.all([
    optionalFirst(
      db,
      `SELECT COUNT(*) AS count, MIN(s.captured_at) AS oldest
         FROM ingest_discovery_items_v1 i
         JOIN ingest_discovery_scans_v1 s ON s.job_id = i.job_id
        WHERE i.status = 'pending'`,
    ),
    optionalCount(db, `SELECT COUNT(*) AS count FROM ingest_stage_redrive_records WHERE outcome = 'denied_rate_limited' AND created_at >= ?`, windowStart),
    optionalCount(db, `SELECT COUNT(*) AS count FROM ingest_stage_dispatch_outbox WHERE dead_lettered_at IS NOT NULL`),
    optionalCount(db, `SELECT COUNT(*) AS count FROM ingest_core_bridge_outbox WHERE dead_lettered_at IS NOT NULL`),
  ]);
  const pendingCount = pending?.count === undefined ? null : Number(pending.count);
  const oldest = typeof pending?.oldest === "string" ? Date.parse(pending.oldest) : NaN;
  return {
    discoveryPendingCount: pendingCount !== null && Number.isFinite(pendingCount) ? Math.max(0, Math.floor(pendingCount)) : null,
    oldestDiscoveryPendingAgeSeconds: Number.isFinite(oldest) ? Math.max(0, Math.floor((Date.now() - oldest) / 1000)) : null,
    redriveRateLimitedLastHour: rateLimited,
    dispatchOutboxDeadLetters: dispatchDead,
    bridgeOutboxDeadLetters: bridgeDead,
  };
}

/**
 * Show each staged source's latest discovery separately from downstream
 * processing. A succeeded discovery is not proof that its items were published.
 */
export async function getStagedCollectionSnapshot(
  db = getRuntimeD1Binding("worldcons_ingest"),
): Promise<StagedCollectionSnapshot> {
  if (!db) return { available: false, reason: "단계별 수집 D1 연결이 없습니다." };
  try {
    const [discoveries, followups] = await Promise.all([
      checkedRows<DiscoveryRow>(db, `SELECT id,source_key,status,created_at,updated_at
         FROM ingest_stage_jobs
         WHERE stage='discovery' AND article_id LIKE 'native-discovery:%'
           AND source_key IN ('de-bverfg','es-tribunal-constitucional','fr-conseil-constitutionnel')
         ORDER BY created_at DESC,id DESC LIMIT 120`),
      checkedRows<FollowupRow>(db, `SELECT source_key,stage,status,COUNT(*) AS count,MAX(updated_at) AS updated_at
         FROM ingest_stage_jobs
         WHERE stage <> 'discovery' AND source_key IN ('de-bverfg','es-tribunal-constitucional','fr-conseil-constitutionnel')
         GROUP BY source_key,stage,status ORDER BY updated_at DESC`),
    ]);
    const observability = await readObservability(db);

    const recentDiscoveries: StagedDiscoveryRun[] = discoveries.map((row) => {
      if (!row.id || !row.source_key || !row.created_at || !row.updated_at || !row.status) {
        throw new Error("collection_status.invalid_discovery");
      }
      return {
        id: row.id,
        sourceKey: row.source_key,
        status: row.status,
        startedAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
    const sources = STAGED_COLLECTION_SOURCES.map((sourceKey): StagedSourceStatus => {
      const latestDiscovery = recentDiscoveries.find((run) => run.sourceKey === sourceKey) ?? null;
      const latestStep = followups.find((row) => row.source_key === sourceKey);
      if (latestStep && (!latestStep.updated_at || !latestStep.status || !latestStep.stage)) {
        throw new Error("collection_status.invalid_followup");
      }
      const latestFollowup = latestStep
        ? { stage: latestStep.stage, status: latestStep.status, updatedAt: latestStep.updated_at }
        : null;
      const downstreamDeadLetterCount = followups
        .filter((row) => row.source_key === sourceKey && row.status === "dead_letter")
        .reduce((total, row) => total + Math.max(0, Number(row.count ?? 1) || 0), 0);
      return { sourceKey, latestDiscovery, latestFollowup, downstreamDeadLetterCount };
    });
    return { available: true, sources, recentDiscoveries, observability };
  } catch {
    return { available: false, reason: "단계별 수집 이력을 조회하지 못했습니다." };
  }
}
