import { getRuntimeD1Binding, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const HISTORY_DAYS = 60;

type D1Row = Record<string, unknown>;

export interface SourceGrowthRow {
  sourceKey: string;
  name: string;
  total: number;
  recent1d: number;
  recent7d: number;
  recent30d: number;
  previous1d: number;
  previous7d: number;
  previous30d: number;
  days: Array<{ date: string; count: number }>;
}

export type SourceGrowthSnapshot =
  | { available: true; generatedAt: string; todayKst: string; sources: SourceGrowthRow[]; total: SourceGrowthRow }
  | { available: false; generatedAt: string; todayKst: string; reason: string };

function checkedCount(value: unknown): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("dashboard.invalid_count");
  return result;
}

async function query(db: D1RuntimeDatabase, sql: string, params: string[] = []): Promise<D1Row[]> {
  const response = await db.prepare(sql).bind(...params).all<D1Row>();
  if (response.success === false || response.error || !Array.isArray(response.results)) {
    throw new Error("dashboard.d1_read_failed");
  }
  return response.results;
}

function dateKey(utcMs: number): string {
  return new Date(utcMs).toISOString().slice(0, 10);
}

function sum(values: number[]): number {
  return values.reduce((result, value) => result + value, 0);
}

/**
 * New article rows, not crawler requests/refreshes, are counted as growth.
 * A 'day' is a calendar day in Asia/Seoul; the current day is partial.
 * All aggregates run in D1 and never rely on a bounded list of article rows.
 */
export async function getAdminSourceGrowthSnapshot(
  now = new Date(),
  db = getRuntimeD1Binding("worldcons_core"),
): Promise<SourceGrowthSnapshot> {
  const generatedAt = now.toISOString();
  const todayKst = dateKey(now.getTime() + KST_OFFSET_MS);
  if (!db) return { available: false, generatedAt, todayKst, reason: "D1 연결을 확인할 수 없습니다." };

  const todayStartUtc = Date.parse(`${todayKst}T00:00:00.000Z`) - KST_OFFSET_MS;
  const firstDayUtc = todayStartUtc - (HISTORY_DAYS - 1) * DAY_MS;
  const tomorrowStartUtc = todayStartUtc + DAY_MS;
  const dateKeys = Array.from({ length: HISTORY_DAYS }, (_, index) => dateKey(firstDayUtc + KST_OFFSET_MS + index * DAY_MS));

  try {
    const [sourceRows, totalRows, dailyRows] = await Promise.all([
      query(db, "SELECT source_key, name FROM sources ORDER BY source_key"),
      query(db, "SELECT source_key, COUNT(*) AS count FROM articles GROUP BY source_key"),
      query(db, `SELECT source_key, date(created_at, '+9 hours') AS day, COUNT(*) AS count
                 FROM articles WHERE created_at >= ? AND created_at < ?
                 GROUP BY source_key, day ORDER BY day, source_key`,
        [new Date(firstDayUtc).toISOString(), new Date(tomorrowStartUtc).toISOString()]),
    ]);
    const sources = new Map<string, { name: string; total: number; daily: Map<string, number> }>();
    for (const row of sourceRows) {
      if (typeof row.source_key !== "string") throw new Error("dashboard.invalid_source");
      sources.set(row.source_key, {
        name: typeof row.name === "string" ? row.name : row.source_key,
        total: 0,
        daily: new Map(),
      });
    }
    for (const row of totalRows) {
      if (typeof row.source_key !== "string") throw new Error("dashboard.invalid_source");
      const found = sources.get(row.source_key) ?? { name: row.source_key, total: 0, daily: new Map<string, number>() };
      found.total = checkedCount(row.count);
      sources.set(row.source_key, found);
    }
    for (const row of dailyRows) {
      if (typeof row.source_key !== "string" || typeof row.day !== "string" || !dateKeys.includes(row.day)) {
        throw new Error("dashboard.invalid_daily_row");
      }
      const found = sources.get(row.source_key) ?? { name: row.source_key, total: 0, daily: new Map<string, number>() };
      found.daily.set(row.day, checkedCount(row.count));
      sources.set(row.source_key, found);
    }

    function toRow(sourceKey: string, name: string, total: number, counts: number[]): SourceGrowthRow {
      return {
        sourceKey, name, total,
        recent1d: counts[59], previous1d: counts[58],
        recent7d: sum(counts.slice(53)), previous7d: sum(counts.slice(46, 53)),
        recent30d: sum(counts.slice(30)), previous30d: sum(counts.slice(0, 30)),
        days: dateKeys.slice(30).map((date, index) => ({ date, count: counts[index + 30] })),
      };
    }

    const rows = [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([sourceKey, source]) => {
      const counts = dateKeys.map((day) => source.daily.get(day) ?? 0);
      return toRow(sourceKey, source.name, source.total, counts);
    });
    const allCounts = dateKeys.map((day) => sum([...sources.values()].map((source) => source.daily.get(day) ?? 0)));
    const all = toRow("all", "전체 수집원", sum(rows.map((source) => source.total)), allCounts);
    return { available: true, generatedAt, todayKst, sources: rows, total: all };
  } catch {
    // Never present an incomplete or failed D1 aggregate as genuine zero counts.
    return { available: false, generatedAt, todayKst, reason: "수집 통계를 조회하지 못했습니다." };
  }
}
