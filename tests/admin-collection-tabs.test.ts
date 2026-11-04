import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getStagedCollectionSnapshot } from "../lib/admin/staged-collection-status";
import type { D1RuntimeDatabase } from "../lib/cloudflare/d1/runtime-binding";

function fakeIngestDb(options: { fail?: boolean } = {}): D1RuntimeDatabase {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async all<T>() {
          if (options.fail) return { success: false, results: [] as T[], error: "unavailable" };
          if (sql.includes("stage='discovery'")) return { success: true, results: [
            { id: "d3", source_key: "de-bverfg", status: "succeeded", created_at: "2026-11-04T21:00:00Z", updated_at: "2026-11-04T21:45:00Z" },
            { id: "d2", source_key: "es-tribunal-constitucional", status: "succeeded", created_at: "2026-11-04T21:00:00Z", updated_at: "2026-11-04T21:30:00Z" },
            { id: "d1", source_key: "fr-conseil-constitutionnel", status: "succeeded", created_at: "2026-11-04T21:00:00Z", updated_at: "2026-11-04T21:15:00Z" },
          ] as T[] };
          return { success: true, results: [
            { source_key: "de-bverfg", stage: "crawl", status: "succeeded", updated_at: "2026-11-04T22:45:00Z" },
            { source_key: "es-tribunal-constitucional", stage: "search", status: "succeeded", updated_at: "2026-11-04T23:30:00Z" },
            { source_key: "fr-conseil-constitutionnel", stage: "publish", status: "succeeded", updated_at: "2026-11-02T23:30:00Z" },
          ] as T[] };
        },
      };
    },
  };
}

test("source status includes all three staged collectors and preserves discovery vs follow-up meaning", async () => {
  const result = await getStagedCollectionSnapshot(fakeIngestDb());
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.deepEqual(result.sources.map((source) => source.sourceKey), [
    "de-bverfg", "es-tribunal-constitucional", "fr-conseil-constitutionnel",
  ]);
  assert.equal(result.sources[0].latestDiscovery?.status, "succeeded");
  assert.equal(result.sources[0].latestFollowup?.stage, "crawl");
  assert.equal(result.sources[1].latestFollowup?.stage, "search");
  assert.ok(result.sources[2].latestFollowup!.updatedAt < result.sources[2].latestDiscovery!.startedAt);
  assert.equal(result.recentDiscoveries.length, 3);
});

test("staged status fails closed on missing or failed D1 query", async () => {
  assert.equal((await getStagedCollectionSnapshot(null)).available, false);
  assert.equal((await getStagedCollectionSnapshot(fakeIngestDb({ fail: true }))).available, false);
});

test("collection status uses three tabs and excludes old runbook / violations panels", () => {
  const root = process.cwd();
  const page = fs.readFileSync(path.join(root, "app/admin/ops/page.tsx"), "utf8");
  const tabs = fs.readFileSync(path.join(root, "components/admin-collection-status-tabs.tsx"), "utf8");
  for (const label of ["소스별 수집 상태", "최근 수집 실행", "최근 운영 이벤트"]) {
    assert.match(tabs, new RegExp(label));
  }
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /role="tabpanel"/);
  assert.match(tabs, /aria-selected/);
  assert.match(tabs, /ArrowRight/);
  assert.match(page, /isAuthorizedPageRequest/);
  assert.match(page, /listAdminOpsEvents\(20\)/);
  assert.doesNotMatch(page + tabs, /RunbookSection|ViolationList|운영 지침|위반 사항/);
});
