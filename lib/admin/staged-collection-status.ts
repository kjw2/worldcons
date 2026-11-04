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
}

export type StagedCollectionSnapshot =
  | { available: true; sources: StagedSourceStatus[]; recentDiscoveries: StagedDiscoveryRun[] }
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
}

async function checkedRows<T>(db: D1RuntimeDatabase, sql: string): Promise<T[]> {
  const response = await db.prepare(sql).all<T>();
  if (response.success === false || response.error || !Array.isArray(response.results)) {
    throw new Error("collection_status.d1_query_failed");
  }
  return response.results;
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
      checkedRows<FollowupRow>(db, `SELECT source_key,stage,status,MAX(updated_at) AS updated_at
         FROM ingest_stage_jobs
         WHERE stage <> 'discovery' AND source_key IN ('de-bverfg','es-tribunal-constitucional','fr-conseil-constitutionnel')
         GROUP BY source_key,stage,status ORDER BY updated_at DESC`),
    ]);

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
      return { sourceKey, latestDiscovery, latestFollowup };
    });
    return { available: true, sources, recentDiscoveries };
  } catch {
    return { available: false, reason: "단계별 수집 이력을 조회하지 못했습니다." };
  }
}
