import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import {
  isSpainPendingPromotionStale,
  readSourceCollectionCheckpoint,
} from "../lib/cloudflare/ingest-write/ingestion-runs-read";
import type { D1RuntimeDatabase, D1RuntimePreparedStatement } from "../lib/cloudflare/d1/runtime-binding";

function binding(database: DatabaseSync): D1RuntimeDatabase {
  return {
    prepare(sql: string): D1RuntimePreparedStatement {
      const statement = database.prepare(sql);
      let values: SQLInputValue[] = [];
      const chain: D1RuntimePreparedStatement = {
        bind(...next: unknown[]) { values = next as SQLInputValue[]; return chain; },
        async all<T>() { return { success: true, results: statement.all(...values) as unknown as T[] }; },
      };
      return chain;
    },
  };
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE ingestion_runs (
      id TEXT PRIMARY KEY, source_key TEXT, status TEXT,
      started_at TEXT, finished_at TEXT, metadata TEXT
    );
  `);
  return { database, db: binding(database) };
}

test("the incremental checkpoint is read from D1 completed runs, not the retired Supabase client", async () => {
  const { database, db } = fixture();
  database.prepare("INSERT INTO ingestion_runs VALUES (?,?,?,?,?,?)").run("old", "es-tribunal-constitucional", "completed", "2026-11-01T00:00:00.000Z", "2026-11-01T01:00:00.000Z", JSON.stringify({ lastVerifiedPublishedAt: "2026-10-25T00:00:00.000Z", pendingRecheckCount: 2 }));
  database.prepare("INSERT INTO ingestion_runs VALUES (?,?,?,?,?,?)").run("new", "es-tribunal-constitucional", "completed", "2026-11-20T00:00:00.000Z", "2026-11-20T01:00:00.000Z", JSON.stringify({ lastVerifiedPublishedAt: "2026-11-18T00:00:00.000Z", pendingRecheckCount: 0 }));
  database.prepare("INSERT INTO ingestion_runs VALUES (?,?,?,?,?,?)").run("running", "es-tribunal-constitucional", "running", "2026-11-21T00:00:00.000Z", null, JSON.stringify({ lastVerifiedPublishedAt: "2026-11-21T00:00:00.000Z" }));
  const checkpoint = await readSourceCollectionCheckpoint(db, "es-tribunal-constitucional");
  assert.deepEqual(checkpoint, {
    lastSuccessfulRunAt: "2026-11-20T01:00:00.000Z",
    lastVerifiedPublishedAt: "2026-11-18T00:00:00.000Z",
  });
  database.close();
});

test("Spanish pending-promotion staleness uses the two newest completed D1 runs", async () => {
  const { database, db } = fixture();
  for (const [id, finished, pending, promoted] of [
    ["r1", "2026-11-19T00:00:00.000Z", 3, 0],
    ["r2", "2026-11-20T00:00:00.000Z", 2, 0],
  ] as const) {
    database.prepare("INSERT INTO ingestion_runs VALUES (?,?,?,?,?,?)").run(id, "es-tribunal-constitucional", "completed", finished, finished, JSON.stringify({ pendingRecheckCount: pending, spainSourceTextPromotedCount: promoted }));
  }
  assert.equal(await isSpainPendingPromotionStale(db, { sourceKey: "es-tribunal-constitucional", pendingRecheckCount: 2, promotedCount: 0 }), true);
  assert.equal(await isSpainPendingPromotionStale(db, { sourceKey: "es-tribunal-constitucional", pendingRecheckCount: 2, promotedCount: 1 }), false);
  assert.equal(await isSpainPendingPromotionStale(db, { sourceKey: "es-tribunal-constitucional", pendingRecheckCount: 0, promotedCount: 0 }), false);
  database.close();
});
