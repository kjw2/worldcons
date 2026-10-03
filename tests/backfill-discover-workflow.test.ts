import assert from "node:assert/strict";
import test from "node:test";
import { parseGermanyBackfillDiscoverPayload } from "../workers/async-pipeline/src/backfill-discover";
import { discoverBverfgInventory } from "../lib/crawlee/bverfg-inventory";

test("Germany 2022 discovery workflow payload is exact and fail-closed", () => {
  const parsed = parseGermanyBackfillDiscoverPayload(JSON.stringify({
    year: 2022,phase: "discover",passNumber: 1,maxPages: 50,requestedBy: "test",
  }));
  assert.ok(parsed);
  assert.equal(parseGermanyBackfillDiscoverPayload({ ...parsed, year: 2021 }), null);
  assert.equal(parseGermanyBackfillDiscoverPayload({ ...parsed, passNumber: 2 }), null);
  assert.equal(parseGermanyBackfillDiscoverPayload({ ...parsed, maxPages: 501 }), null);
  assert.equal(parseGermanyBackfillDiscoverPayload({ ...parsed, unexpected: true }), null);
});

test("BVerfG inventory accepts a parsed-page loader without retaining external HTML", async () => {
  const page1 = `<html><body>
    <a data-djo_karte href="/dienste/vernetzung/rechtsprechung?Text=1+BvR+1%2F22">BVerfG, 10.01.2022 - 1 BvR 1/22</a>
    <a href="?gericht=BVerfG&seite=2">2</a>
  </body></html>`;
  const page2 = `<html><body>
    <a data-djo_karte href="/dienste/vernetzung/rechtsprechung?Text=1+BvR+2%2F21">BVerfG, 31.12.2021 - 1 BvR 2/21</a>
    <a href="?gericht=BVerfG&seite=2">2</a>
  </body></html>`;
  const { parseBverfgDejureInventoryPage } = await import("../lib/crawlee/bverfg-inventory");
  let firstPageReads = 0;
  const result = await discoverBverfgInventory({
    year: 2022,currentYear: 2026,maxPages: 2,
    loadPage: async (_url, page) => {
      const html = page === 1 ? page1 : page2;
      if (page === 1) firstPageReads += 1;
      return {
        parsed: parseBverfgDejureInventoryPage(html, page),
        responseHash: (page === 1 ? "a" : "b").repeat(64),
      };
    },
  });
  assert.equal(firstPageReads, 2);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].decisionDateHint, "2022-01-10");
  assert.equal(result.enumerationArtifacts.length, 3);
  assert.equal(result.enumerationArtifacts[0].responseHash, "a".repeat(64));
  assert.equal(result.enumerationArtifacts[1].responseHash, "b".repeat(64));
  assert.equal(result.enumerationArtifacts[2].artifactKind, "boundary_probe");
});
