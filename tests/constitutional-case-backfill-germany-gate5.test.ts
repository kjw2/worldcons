import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGermanyBverfgYearEnabled,
  CASE_CATALOG_GERMANY_HISTORY_FLAG,
  GERMANY_BVERFG_HISTORY_START_YEAR,
  germanyBverfgExpansionPlan,
  germanyBverfgYearEnabled,
  germanyBverfgYearScope,
} from "../lib/backfill/germany-scope";
import {
  discoverBverfgInventory,
  parseBverfgDejureInventoryPage,
} from "../lib/crawlee/bverfg-inventory";
import { loadCaseBackfillSourceStrategy } from "../lib/backfill/source-strategies";
import type { CaseBackfillClaimedItem, CaseBackfillSnapshot } from "../lib/backfill/types";
import type { NormalizedArticle } from "../lib/sources/types";
import { bverfgOfficialUrlCandidatesForItem } from "../lib/sources/bundesverfassungsgericht";

interface FixtureRow {
  date: string;
  docket: string;
  title?: string;
}

function dejurePage(rows: FixtureRow[], pages: number[], popular?: FixtureRow) {
  const popularHtml = popular
    ? `<a href="/popular">BVerfG, ${popular.date} - ${popular.docket}</a>`
    : "";
  const rowHtml = rows.map((row) => {
    const href = `/dienste/vernetzung/rechtsprechung?Gericht=BVerfG&Datum=${row.date}&Aktenzeichen=${encodeURIComponent(row.docket)}`;
    return `<li><a data-djo_karte="+|-|-|-" href="${href}" title="${row.title ?? ""}">BVerfG, ${row.date} - ${row.docket}</a></li>`;
  }).join("");
  const pagination = pages.map((page) => (
    `<a href="/dienste/rechtsprechung?gericht=BVerfG&amp;seite=${page}">${page}</a>`
  )).join("");
  return `<html><body>${popularHtml}<ol>${rowHtml}</ol><nav>${pagination}</nav></body></html>`;
}

test("Germany BVerfG scope is annual, 1998-bounded, and disabled by default", () => {
  assert.equal(GERMANY_BVERFG_HISTORY_START_YEAR, 1998);
  assert.deepEqual(germanyBverfgYearScope(2024, 2026), {
    year: 2024,
    scopeFrom: "2024-01-01",
    scopeTo: "2024-12-31",
    documentType: "DECISION",
  });
  assert.throws(() => germanyBverfgYearScope(1997, 2026), /germany_year_not_supported/);
  assert.throws(() => germanyBverfgYearScope(2027, 2026), /germany_year_not_supported/);
  assert.equal(germanyBverfgYearEnabled(2024, {}, 2026), false);
  assert.equal(germanyBverfgYearEnabled(2024, { [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true" }, 2026), true);
  assert.throws(() => assertGermanyBverfgYearEnabled(2024, {}, 2026), /germany_history_disabled/);
  const plan = germanyBverfgExpansionPlan({}, 2026);
  assert.equal(plan[0].year, 2026);
  assert.equal(plan.at(-1)?.year, 1998);
  assert.equal(plan.every((entry) => !entry.enabled), true);
});

test("dejure parser ignores popular links and keeps same-docket decisions on different dates", () => {
  const parsed = parseBverfgDejureInventoryPage(dejurePage([
    { date: "15.04.2021", docket: "2 BvR 547/21", title: "Zweiter Beschluss" },
    { date: "26.03.2021", docket: "2 BvR 547/21", title: "Erster Beschluss" },
    { date: "01.03.2021", docket: "3 Unknown 1/21", title: "Unresolved" },
  ], [2, 426], { date: "17.12.1953", docket: "1 BvR 147/52" }), 1);

  assert.equal(parsed.items.length, 3);
  assert.equal(parsed.items[0].decisionDateHint, "2021-04-15");
  assert.notEqual(parsed.items[0].stableItemKey, parsed.items[1].stableItemKey);
  assert.equal(parsed.items[0].sourceRecordId, null);
  assert.equal(parsed.items[0].inventoryMetadata.sourceUrlVerified, false);
  assert.equal(parsed.items[0].inventoryMetadata.authorityVerificationRequired, true);
  assert.deepEqual(
    (parsed.items[0].inventoryMetadata.officialUrlCandidates as string[]).map((url) => url.split("/").at(-1)),
    ["rk20210415_2bvr054721.html", "rs20210415_2bvr054721.html"],
  );
  assert.equal(parsed.items[2].discoveredUrl, "https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html");
  assert.equal(parsed.observedLastPage, 426);
  assert.equal(parsed.hasNextPage, true);
  assert.match(parsed.listingFingerprint, /^[0-9a-f]{64}$/);
});

test("external-index inventory crosses the annual boundary and verifies a stable first-page probe", async () => {
  const fixtures = new Map<number, string>([
    [1, dejurePage([
      { date: "10.01.2025", docket: "1 BvR 10/25" },
      { date: "31.12.2024", docket: "1 BvR 20/24" },
    ], [2, 3])],
    [2, dejurePage([
      { date: "31.12.2024", docket: "1 BvR 20/24" },
      { date: "02.01.2024", docket: "2 BvR 547/21" },
    ], [1, 3])],
    [3, dejurePage([
      { date: "31.12.2023", docket: "1 BvR 30/23" },
    ], [1, 2])],
  ]);
  const calls: number[] = [];
  const inventory = await discoverBverfgInventory({
    year: 2024,
    currentYear: 2026,
    maxPages: 3,
    fetchPage: async (_url, page) => {
      calls.push(page);
      const fixture = fixtures.get(page);
      if (!fixture) throw new Error("unexpected page");
      return fixture;
    },
  });

  assert.deepEqual(calls, [1, 2, 3, 1]);
  assert.equal(inventory.pageCount, 3);
  assert.equal(inventory.requestCount, 4);
  assert.equal(inventory.items.length, 2);
  assert.equal(inventory.expectedCount, null);
  assert.equal(inventory.expectedCountBasis, null);
  assert.equal(inventory.coverageEvidence.coverageAssurance, "external_index_assisted");
  assert.equal(inventory.coverageEvidence.officialCorpusCoverageClaimed, false);
  assert.equal(inventory.coverageEvidence.crossedOlderBoundary, true);
  assert.equal(inventory.coverageEvidence.firstPageProbeStable, true);
});

test("external-index inventory fails closed when the listing changes during pagination", async () => {
  let firstPageReads = 0;
  await assert.rejects(
    discoverBverfgInventory({
      year: 2024,
      currentYear: 2026,
      maxPages: 2,
      fetchPage: async (_url, page) => {
        if (page === 1) {
          firstPageReads += 1;
          return dejurePage([
            { date: "31.12.2024", docket: firstPageReads === 1 ? "1 BvR 20/24" : "1 BvR 21/24" },
          ], [2]);
        }
        return dejurePage([{ date: "31.12.2023", docket: "1 BvR 30/23" }], [1]);
      },
    }),
    /changed during pagination/,
  );
});

const snapshot: CaseBackfillSnapshot = {
  id: "00000000-0000-4000-8000-000000000301",
  sourceKey: "de-bverfg",
  scopeFrom: "2024-01-01",
  scopeTo: "2024-12-31",
  documentType: "DECISION",
  parserVersion: "bverfg-official-normalize-v1",
  sourcePolicyVersion: "bverfg-policy-v1",
  status: "closed",
};

const item: CaseBackfillClaimedItem = {
  itemId: "00000000-0000-4000-8000-000000000302",
  stableItemKey: "dejure:2024-03-26:2bvr54721",
  sourceRecordId: null,
  discoveredUrl: "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2024/03/rk20240326_2bvr054721.html",
  authorityUrl: null,
  documentType: "DECISION",
  decisionDateHint: "2024-03-26",
  inventoryMetadata: {
    docket: "2 BvR 547/21",
    officialUrlCandidates: [
      "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2024/03/rk20240326_2bvr054721.html",
      "https://www.bundesverfassungsgericht.de/SharedDocs/Entscheidungen/DE/2024/03/rs20240326_2bvr054721.html",
    ],
  },
  resolutionStatus: "discovered",
  currentFetchArtifactId: null,
  currentNormalizationArtifactId: null,
  verifiedNormalizationArtifactId: null,
  publishedNormalizationArtifactId: null,
  itemLeaseExpiresAt: "2026-09-04T00:00:00.000Z",
};

function normalized(overrides: Partial<NormalizedArticle> = {}): NormalizedArticle {
  return {
    sourceKey: "de-bverfg",
    jurisdiction: "Germany",
    institutionName: "Bundesverfassungsgericht",
    contentType: "decision",
    originalUrl: item.discoveredUrl,
    canonicalUrl: item.discoveredUrl,
    originalLanguage: "de",
    originalTitle: "Beschluss vom 26. März 2024",
    originalPublishedAt: "2024-03-26T00:00:00.000Z",
    cleanedText: "Amtlicher Entscheidungstext ".repeat(100),
    metadata: {
      decisionDate: "2024-03-26",
      caseNumber: "2 BvR 547/21",
      collection: { sourceUrlVerified: true, sourceTextAvailable: true, publishable: true },
    },
    ...overrides,
  };
}

test("Germany strategy requires the flag and verifies official authority identity", () => {
  const strategy = loadCaseBackfillSourceStrategy("de-bverfg", { currentYear: 2026 });
  assert.throws(() => strategy.assertDiscoveryScope(snapshot, {}), /germany_history_disabled/);
  assert.doesNotThrow(() => strategy.assertDiscoveryScope(snapshot, {
    [CASE_CATALOG_GERMANY_HISTORY_FLAG]: "true",
  }));
  assert.deepEqual(strategy.validate(normalized(), item, snapshot), []);
  assert.ok(strategy.validate(normalized({
    canonicalUrl: "https://dejure.org/dienste/rechtsprechung?gericht=BVerfG",
  }), item, snapshot).includes("authority_url_invalid"));
  assert.ok(strategy.validate(normalized({
    metadata: {
      decisionDate: "2024-03-26",
      caseNumber: "2 BvR 547/21",
      collection: { sourceUrlVerified: false, sourceTextAvailable: true, publishable: true },
    },
  }), item, snapshot).includes("official_source_not_verified"));
  assert.ok(strategy.validate(normalized({
    metadata: {
      decisionDate: "2024-03-26",
      caseNumber: "1 BvR 1/24",
      collection: { sourceUrlVerified: true, sourceTextAvailable: true, publishable: true },
    },
  }), item, snapshot).includes("docket_mismatch"));
  assert.ok(strategy.validate(normalized({
    cleanedText: "",
    metadata: {
      decisionDate: "2024-03-26",
      caseNumber: "2 BvR 547/21",
      collection: { sourceUrlVerified: true, sourceTextAvailable: false, publishable: false },
    },
  }), item, snapshot).includes("official_source_text_missing"));
});

test("BVerfG fetch candidates come from sealed inventory and reject non-official URLs", () => {
  const candidates = bverfgOfficialUrlCandidatesForItem({
    sourceKey: "de-bverfg",
    url: item.discoveredUrl,
    canonicalUrl: item.discoveredUrl,
    contentType: "decision",
    metadata: {
      sourceInventory: {
        officialUrlCandidates: [
          "https://attacker.example/SharedDocs/Entscheidungen/DE/2024/03/rk20240326_2bvr054721.html",
          ...(item.inventoryMetadata.officialUrlCandidates as string[]),
        ],
      },
    },
  });
  assert.deepEqual(candidates, item.inventoryMetadata.officialUrlCandidates);
  assert.deepEqual(bverfgOfficialUrlCandidatesForItem({
    sourceKey: "de-bverfg",
    url: "https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html",
    canonicalUrl: "https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html",
    contentType: "decision",
    metadata: { sourceInventory: { officialUrlCandidates: [] } },
  }), []);
});
