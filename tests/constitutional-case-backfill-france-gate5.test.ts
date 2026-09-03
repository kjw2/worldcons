import assert from "node:assert/strict";
import test from "node:test";
import {
  CASE_CATALOG_FRANCE_HISTORY_FLAG,
  franceConseilExpansionPlan,
  franceConseilScope,
  franceConseilScopeEnabled,
} from "../lib/backfill/france-scope";
import {
  parseFranceConseilDecisionDate,
  parseFranceConseilInventoryPage,
} from "../lib/crawlee/france-conseil-inventory";

const fixture = `<!doctype html><html><body>
  <div data-drupal-facet-id="page_les_decisions_type">
    <a class="is-active" data-drupal-facet-item-count="2">Question prioritaire de constitutionnalité</a>
  </div>
  <div class="view-recherche">
    <a href="/decision/2024/20241115QPC.htm" title="Décision n° 2024-1115 QPC du 13 décembre 2024">QPC</a>
    <a href="/decision/2024/20241091_1092_1093QPC.htm" title="Décision n° 2024-1091/1092/1093 QPC du 28 mai 2024">QPC groupée</a>
    <a href="/decision/2024/20241115QPC.htm" title="duplicate">duplicate</a>
    <a href="/decision/2024/2024873DC.htm" title="Décision n° 2024-873 DC du 12 décembre 2024">DC</a>
    <a href="/actualites/communique/decision-n-2024-1115-qpc">communiqué</a>
  </div>
</body></html>`;

test("France scope is annual, QPC/DC-only, current-year bounded, and disabled by default", () => {
  assert.deepEqual(franceConseilScope(2010, "qpc", 2026), {
    year: 2010, scopeFrom: "2010-01-01", scopeTo: "2010-12-31", documentType: "QPC",
  });
  assert.deepEqual(franceConseilScope(2026, "DC", 2026).documentType, "DC");
  assert.throws(() => franceConseilScope(2009, "QPC", 2026), /france_year_not_supported/);
  assert.throws(() => franceConseilScope(2027, "QPC", 2026), /france_year_not_supported/);
  assert.throws(() => franceConseilScope(2024, "L", 2026), /france_document_type_not_supported/);
  assert.equal(franceConseilScopeEnabled(2024, "QPC", {}, 2026), false);
  assert.equal(franceConseilScopeEnabled(2024, "QPC", { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" }, 2026), true);
  const plan = franceConseilExpansionPlan({}, 2011);
  assert.deepEqual(plan.map((entry) => [entry.year, entry.documentType, entry.enabled]), [
    [2010, "QPC", false], [2010, "DC", false], [2011, "QPC", false], [2011, "DC", false],
  ]);
});

test("France official list parser keeps only the requested decision facet and ignores lastmod-like noise", () => {
  const page = parseFranceConseilInventoryPage(fixture, { year: 2024, documentType: "QPC" });
  assert.equal(page.expectedCount, 2);
  assert.equal(page.hasNextPage, false);
  assert.deepEqual(page.items, [
    {
      stableItemKey: "conseil:20241115qpc",
      sourceRecordId: "20241115QPC",
      discoveredUrl: "https://www.conseil-constitutionnel.fr/decision/2024/20241115QPC.htm",
      documentType: "QPC",
      decisionDateHint: "2024-12-13",
      title: "Décision n° 2024-1115 QPC du 13 décembre 2024",
    },
    {
      stableItemKey: "conseil:20241091_1092_1093qpc",
      sourceRecordId: "20241091_1092_1093QPC",
      discoveredUrl: "https://www.conseil-constitutionnel.fr/decision/2024/20241091_1092_1093QPC.htm",
      documentType: "QPC",
      decisionDateHint: "2024-05-28",
      title: "Décision n° 2024-1091/1092/1093 QPC du 28 mai 2024",
    },
  ]);
});

test("France decision date parser handles accents and premier-day notation without using sitemap lastmod", () => {
  assert.equal(parseFranceConseilDecisionDate("Décision n° 2010-1 QPC du 1er mars 2010"), "2010-03-01");
  assert.equal(parseFranceConseilDecisionDate("Décision n° 2024-1 DC du 31 février 2024"), null);
  assert.equal(parseFranceConseilDecisionDate("lastmod 2024-12-31"), null);
});
