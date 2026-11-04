import assert from "node:assert/strict";
import test from "node:test";
import { getAdminSourceGrowthSnapshot } from "../lib/admin/source-growth";
import type { D1RuntimeDatabase } from "../lib/cloudflare/d1/runtime-binding";

type Row = Record<string, unknown>;

function fakeD1(rows: { sources: Row[]; totals: Row[]; daily: Row[] }, options?: { failDaily?: boolean }) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db: D1RuntimeDatabase = {
    prepare(sql) {
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          params = values;
          return this;
        },
        async all<T>() {
          statements.push({ sql, params });
          if (sql.startsWith("SELECT source_key, name")) return { success: true, results: rows.sources as T[] };
          if (sql.startsWith("SELECT source_key, COUNT")) return { success: true, results: rows.totals as T[] };
          if (options?.failDaily) return { success: false, results: [] as T[], error: "database unavailable" };
          return { success: true, results: rows.daily as T[] };
        },
      };
    },
  };
  return { db, statements };
}

const NOW = new Date("2026-11-04T02:00:00.000Z"); // 11:00 in Seoul
const SOURCES = [{ source_key: "de-bverfg", name: "German Court" }, { source_key: "us-scotus", name: "US Court" }];

test("dashboard counts rows added by KST calendar day without counting refreshes", async () => {
  const { db, statements } = fakeD1({
    sources: SOURCES,
    totals: [{ source_key: "de-bverfg", count: 110 }, { source_key: "us-scotus", count: 50 }],
    daily: [
      { source_key: "de-bverfg", day: "2026-11-04", count: 2 },
      { source_key: "de-bverfg", day: "2026-11-03", count: 3 },
      { source_key: "de-bverfg", day: "2026-10-29", count: 4 },
      { source_key: "de-bverfg", day: "2026-10-28", count: 7 },
      { source_key: "de-bverfg", day: "2026-10-20", count: 5 },
      { source_key: "de-bverfg", day: "2026-10-01", count: 11 },
    ],
  });
  const result = await getAdminSourceGrowthSnapshot(NOW, db);
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.todayKst, "2026-11-04");
  const german = result.sources.find((row) => row.sourceKey === "de-bverfg")!;
  assert.deepEqual(
    [german.total, german.recent1d, german.previous1d, german.recent7d, german.previous7d, german.recent30d, german.previous30d],
    [110, 2, 3, 9, 7, 21, 11],
  );
  assert.equal(german.days.length, 30);
  assert.equal(german.days[0].date, "2026-10-06");
  assert.equal(german.days.at(-1)?.date, "2026-11-04");
  assert.equal(result.sources.find((row) => row.sourceKey === "us-scotus")?.recent30d, 0);
  assert.equal(result.total.total, 160);
  assert.equal(result.total.recent30d, 21);
  const dailyQuery = statements.find((statement) => statement.sql.includes("date(created_at"));
  assert.ok(dailyQuery);
  assert.deepEqual(dailyQuery.params, ["2026-09-05T15:00:00.000Z", "2026-11-04T15:00:00.000Z"]);
  assert.ok(statements.some((statement) => statement.sql.includes("COUNT(*)")));
});

test("dashboard includes zero-article sources without inventing additions", async () => {
  const { db } = fakeD1({ sources: SOURCES, totals: [], daily: [] });
  const result = await getAdminSourceGrowthSnapshot(NOW, db);
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.sources.length, 2);
  assert.ok(result.sources.every((row) => row.total === 0 && row.days.every((day) => day.count === 0)));
});

test("D1 unavailable or partially failing never returns fabricated zero statistics", async () => {
  const missing = await getAdminSourceGrowthSnapshot(NOW, null);
  assert.equal(missing.available, false);
  const { db } = fakeD1({ sources: SOURCES, totals: [], daily: [] }, { failDaily: true });
  const failing = await getAdminSourceGrowthSnapshot(NOW, db);
  assert.equal(failing.available, false);
});

test("unexpected daily data is rejected instead of silently changing totals", async () => {
  const { db } = fakeD1({ sources: SOURCES, totals: [], daily: [{ source_key: "de-bverfg", day: "2030-01-01", count: 7 }] });
  const result = await getAdminSourceGrowthSnapshot(NOW, db);
  assert.equal(result.available, false);
});
