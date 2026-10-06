import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverGermanyBackfillInventoryWithLoader,
  parseGermanyBackfillDiscoverPayload,
} from "../workers/async-pipeline/src/backfill-discover";
import { discoverBverfgInventory } from "../lib/crawlee/bverfg-inventory";

test("Germany 2021-2022 discovery workflow payload is exact and fail-closed", () => {
  const parsed = parseGermanyBackfillDiscoverPayload(JSON.stringify({
    year: 2022,phase: "discover",passNumber: 1,maxPages: 50,requestedBy: "test",
  }));
  assert.ok(parsed);
  assert.ok(parseGermanyBackfillDiscoverPayload({ ...parsed, year: 2021 }));
  assert.equal(parseGermanyBackfillDiscoverPayload({ ...parsed, year: 2020 }), null);
  assert.equal(parseGermanyBackfillDiscoverPayload({ ...parsed, year: 2023 }), null);
  assert.equal(parseGermanyBackfillDiscoverPayload({ ...parsed, passNumber: 2 }), null);
  assert.equal(parseGermanyBackfillDiscoverPayload({ ...parsed, maxPages: 501 }), null);
  assert.equal(parseGermanyBackfillDiscoverPayload({ ...parsed, unexpected: true }), null);
});

test("Germany 2021 discovery carries the independently verified 412-target inventory contract", async () => {
  const page1 = `<html><body>
    <a data-djo_karte href="/dienste/vernetzung/rechtsprechung?Text=1+BvR+1%2F21">BVerfG, 23.12.2021 - 1 BvR 1/21</a>
    <a href="?gericht=BVerfG&seite=2">2</a>
  </body></html>`;
  const page2 = `<html><body>
    <a data-djo_karte href="/dienste/vernetzung/rechtsprechung?Text=1+BvR+1%2F20">BVerfG, 31.12.2020 - 1 BvR 1/20</a>
    <a href="?gericht=BVerfG&seite=2">2</a>
  </body></html>`;
  const { parseBverfgDejureInventoryPage } = await import("../lib/crawlee/bverfg-inventory");
  const result = await discoverGermanyBackfillInventoryWithLoader(
    { year: 2021, phase: "discover", passNumber: 1, maxPages: 2, requestedBy: "test" },
    async (_url, page) => ({
      parsed: parseBverfgDejureInventoryPage(page === 1 ? page1 : page2, page),
      responseHash: (page === 1 ? "a" : "b").repeat(64),
    }),
  );
  assert.equal(result.expectedCount, 412);
  assert.equal(result.expectedCountBasis, "dejure_listing_date_docket_audit_2026-10-06");
  assert.equal((result.coverageEvidence.verifiedInventoryAudit as { crosscheckObservedCount: number }).crosscheckObservedCount, 366);
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
