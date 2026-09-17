import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  FRANCE_CONSEIL_APPROVED_POLICY_VERSION,
  FRANCE_CONSEIL_POLICY_VERSION_V1,
  FRANCE_CONSEIL_POLICY_VERSION_V2,
  FRANCE_CONSEIL_POLICY_VERSION_V3,
  FRANCE_CONSEIL_V2_E1_EXCEPTION,
  FRANCE_CONSEIL_V3_OMISSION_EXCEPTIONS,
  franceConseilOmissionExceptionFor,
  franceConseilOmissionExceptionsFor,
  type FranceConseilOmissionException,
} from "../lib/backfill/france-scope";
import {
  buildFranceConseilOmissionItem,
} from "../lib/crawlee/france-dila-constit";
import type { FranceConseilInventoryResult } from "../lib/crawlee/france-conseil-inventory";

function migration(name: string) {
  return fs.readFileSync(path.join(process.cwd(), "supabase/migrations", name), "utf8");
}

const policyV3Migration = migration("20260917090000_constitutional_case_france_policy_v3_approval.sql");

const STOCK_PROVENANCE = {
  filename: "Freemium_constit_global_20250713-140000.tar.gz",
  sha256: "67270556060b481cc139f21436244af913cccd3eb6e074c65d6600f48596f627",
};

const OBSERVED_AT = "2026-09-17T01:00:00.000Z";

function authorityEvidence(exception: FranceConseilOmissionException) {
  return {
    canonicalUrl: exception.authorityUrl,
    pageTitle: exception.conseil.authorityTitle,
    description: exception.conseil.authorityDescription,
    ecli: exception.conseil.ecli,
    jorf: exception.conseil.jorf,
  };
}

function conseilInventory(exception: FranceConseilOmissionException): FranceConseilInventoryResult {
  return {
    sourceKey: "fr-conseil-constitutionnel",
    year: exception.year,
    documentType: exception.documentType,
    expectedCount: 1,
    pageCount: 1,
    items: [{
      stableItemKey: `conseil:${exception.sourceRecordId.toLowerCase()}`,
      sourceRecordId: exception.sourceRecordId,
      discoveredUrl: exception.authorityUrl,
      documentType: exception.documentType,
      decisionDateHint: exception.conseil.decisionDate,
      title: exception.conseil.authorityTitle,
    }],
    coverageEvidence: { method: "official_conseil_annual_type_pagination" },
  };
}

function buildInput(exception: FranceConseilOmissionException) {
  return {
    year: exception.year,
    documentType: exception.documentType,
    policyVersion: FRANCE_CONSEIL_POLICY_VERSION_V3,
    exception,
    dilaAbsenceScan: { identityHits: 0, norHits: exception.conseil.nor ? 0 : null, ecliHits: 0 },
    conseil: conseilInventory(exception),
    authorityEvidence: authorityEvidence(exception),
    stockProvenance: STOCK_PROVENANCE,
    incrementCount: 21,
    memberScanCount: 7600,
    observedAt: OBSERVED_AT,
  };
}

test("France v3 exposes exactly the six 2017 QPC omission tuples and nothing else", () => {
  assert.equal(FRANCE_CONSEIL_APPROVED_POLICY_VERSION, "france-dila-constit-2026-09-v4");
  assert.equal(FRANCE_CONSEIL_V3_OMISSION_EXCEPTIONS.length, 6);
  const ids = [...FRANCE_CONSEIL_V3_OMISSION_EXCEPTIONS].map((e) => e.sourceRecordId).sort();
  assert.deepEqual(ids, [
    "2016613QPC",
    "2017663QPC",
    "2017664QPC",
    "2017665QPC",
    "2017666QPC",
    "2017670QPC",
  ]);
  for (const exception of FRANCE_CONSEIL_V3_OMISSION_EXCEPTIONS) {
    assert.equal(exception.year, 2017);
    assert.equal(exception.documentType, "QPC");
    assert.equal(exception.provider, "conseil");
    assert.equal(exception.reasonCode, "dila_omission_verified_absent");
    assert.equal(exception.conseil.nor, null);
    assert.equal(exception.stableItemKey, `constit:conseil-omission:${exception.sourceRecordId.toLowerCase()}`);
    assert.equal(exception.authorityUrl, `https://www.conseil-constitutionnel.fr/decision/2017/${exception.sourceRecordId}.htm`);
  }
  // Exact year/type/policy gating with no wildcard or year-wide fallback.
  assert.deepEqual(franceConseilOmissionExceptionsFor(2017, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V3), FRANCE_CONSEIL_V3_OMISSION_EXCEPTIONS);
  assert.deepEqual(franceConseilOmissionExceptionsFor(2017, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V2), []);
  assert.deepEqual(franceConseilOmissionExceptionsFor(2017, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V1), []);
  assert.deepEqual(franceConseilOmissionExceptionsFor(2017, "QPC", null), []);
  assert.deepEqual(franceConseilOmissionExceptionsFor(2017, "DC", FRANCE_CONSEIL_POLICY_VERSION_V3), []);
  for (const year of [2010, 2016, 2018, 2019, 2022, 2024]) {
    assert.deepEqual(franceConseilOmissionExceptionsFor(year, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V3), [], String(year));
  }
  // The singular accessor only resolves an unambiguous single tuple.
  assert.equal(franceConseilOmissionExceptionFor(2017, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V3), null);
  // 2022 v2 E1 is untouched.
  assert.deepEqual(franceConseilOmissionExceptionsFor(2022, "DC", FRANCE_CONSEIL_POLICY_VERSION_V2), [FRANCE_CONSEIL_V2_E1_EXCEPTION]);
});

test("France v3 builds every exact omission tuple with its per-discover absence proof", () => {
  for (const exception of FRANCE_CONSEIL_V3_OMISSION_EXCEPTIONS) {
    const item = buildFranceConseilOmissionItem(buildInput(exception));
    assert.equal(item.stableItemKey, exception.stableItemKey);
    assert.equal(item.sourceRecordId, exception.sourceRecordId);
    assert.equal(item.discoveredUrl, exception.authorityUrl);
    assert.equal(item.documentType, "QPC");
    assert.equal(item.decisionDateHint, exception.conseil.decisionDate);
    assert.equal(item.dilaId, undefined);
    assert.equal(item.archiveMemberPath, undefined);
    const metadata = item.inventoryMetadata as Record<string, unknown>;
    assert.equal("dila" in metadata, false);
    assert.equal(metadata.provider, "conseil");
    assert.equal(metadata.reasonCode, "dila_omission_verified_absent");
    assert.equal(metadata.authorityUrl, exception.authorityUrl);
  }

  const representative = FRANCE_CONSEIL_V3_OMISSION_EXCEPTIONS.find((e) => e.sourceRecordId === "2017663QPC")!;
  const item = buildFranceConseilOmissionItem(buildInput(representative));
  assert.deepEqual(item.inventoryMetadata, {
    provider: "conseil",
    reasonCode: "dila_omission_verified_absent",
    authorityUrl: representative.authorityUrl,
    conseil: {
      sourceRecordId: "2017663QPC",
      canonicalUrl: representative.authorityUrl,
      ecli: "ECLI:FR:CC:2017:2017.663.QPC",
      decisionNumber: "2017-663",
      decisionDate: "2017-10-19",
      jorf: "JORF n° 2048 du 22 octobre 2017",
      nor: null,
      authorityObservedAt: OBSERVED_AT,
      authorityTitle: "Décision n° 2017-663 QPC du 19 octobre 2017",
      authorityDescription: "Époux T. [Exonération d'impôt sur le revenu de l'indemnité compensatrice de cessation de mandat d'un agent général d'assurances II]",
    },
    dilaLookup: {
      stockFilename: STOCK_PROVENANCE.filename,
      stockSha256: STOCK_PROVENANCE.sha256,
      incrementsApplied: 21,
      memberScanCount: 7600,
      sourceRecordIdSearched: "2017663QPC",
      norSearched: null,
      ecliSearched: "ECLI:FR:CC:2017:2017.663.QPC",
      identityHits: 0,
      norHits: null,
      ecliHits: 0,
      result: "absent",
      observedAt: OBSERVED_AT,
    },
    license: {
      id: "conseil-official-decision",
      url: representative.authorityUrl,
      attribution: "Conseil constitutionnel",
    },
  });
});

test("France v3 fails closed on stale DILA presence, wrong policy, and every corroboration drift", () => {
  const exception = FRANCE_CONSEIL_V3_OMISSION_EXCEPTIONS[0];
  const base = buildInput(exception);

  assert.throws(
    () => buildFranceConseilOmissionItem({ ...base, dilaAbsenceScan: { identityHits: 1, norHits: null, ecliHits: 0 } }),
    /france_conseil_omission_stale:identity_present_in_dila/,
  );
  assert.throws(
    () => buildFranceConseilOmissionItem({ ...base, dilaAbsenceScan: { identityHits: 0, norHits: null, ecliHits: 1 } }),
    /france_conseil_omission_stale:identity_present_in_dila/,
  );
  for (const policyVersion of [FRANCE_CONSEIL_POLICY_VERSION_V1, FRANCE_CONSEIL_POLICY_VERSION_V2, null, undefined]) {
    assert.throws(
      () => buildFranceConseilOmissionItem({ ...base, policyVersion, exception: undefined }),
      /france_conseil_omission_not_enabled/,
      String(policyVersion),
    );
  }
  // Exception tuple bound to a different year/type can never be applied.
  assert.throws(
    () => buildFranceConseilOmissionItem({ ...base, year: 2016 }),
    /france_conseil_omission_not_enabled/,
  );
  assert.throws(
    () => buildFranceConseilOmissionItem({ ...base, documentType: "DC" }),
    /france_conseil_omission_not_enabled/,
  );
  // Corroboration drift: URL, date, decision number, detail title, description, ECLI, JORF.
  assert.throws(
    () => buildFranceConseilOmissionItem({
      ...base,
      conseil: { expectedCount: 1, items: [{ ...conseilInventory(exception).items[0], discoveredUrl: `${exception.authorityUrl}x` }] },
    }),
    /france_conseil_omission_corroboration_drift:authority_url/,
  );
  assert.throws(
    () => buildFranceConseilOmissionItem({
      ...base,
      conseil: { expectedCount: 1, items: [{ ...conseilInventory(exception).items[0], decisionDateHint: "2017-02-25" }] },
    }),
    /france_conseil_omission_corroboration_drift:decision_date/,
  );
  assert.throws(
    () => buildFranceConseilOmissionItem({
      ...base,
      conseil: { expectedCount: 1, items: [{ ...conseilInventory(exception).items[0], title: "Décision n° 2016-999 QPC du 24 février 2017" }] },
    }),
    /france_conseil_omission_corroboration_drift:decision_number/,
  );
  assert.throws(
    () => buildFranceConseilOmissionItem({
      ...base,
      authorityEvidence: { ...authorityEvidence(exception), pageTitle: "Décision n° 2016-613 QPC du 23 février 2017" },
    }),
    /france_conseil_omission_corroboration_drift:detail_title/,
  );
  assert.throws(
    () => buildFranceConseilOmissionItem({
      ...base,
      authorityEvidence: { ...authorityEvidence(exception), description: "Autre description" },
    }),
    /france_conseil_omission_corroboration_drift:description/,
  );
  assert.throws(
    () => buildFranceConseilOmissionItem({
      ...base,
      authorityEvidence: { ...authorityEvidence(exception), ecli: "ECLI:FR:CC:2017:2016.999.QPC" },
    }),
    /france_conseil_omission_corroboration_drift:ecli/,
  );
  assert.throws(
    () => buildFranceConseilOmissionItem({
      ...base,
      authorityEvidence: { ...authorityEvidence(exception), jorf: "JORF n°9999 du 1 janvier 2017" },
    }),
    /france_conseil_omission_corroboration_drift:jorf/,
  );
  // Missing Conseil corroboration fails closed.
  assert.throws(
    () => buildFranceConseilOmissionItem({
      ...base,
      conseil: { expectedCount: 1, items: [{ ...conseilInventory(exception).items[0], sourceRecordId: "2016999QPC" }] },
    }),
    /france_conseil_omission_corroboration_missing/,
  );
});

test("France v2 2022 E1 remains a single exact tuple and is not widened by v3", () => {
  assert.equal(FRANCE_CONSEIL_V2_E1_EXCEPTION.conseil.nor, "CSCL2237744S");
  assert.equal(FRANCE_CONSEIL_V2_E1_EXCEPTION.conseil.authorityDescription, "Loi de finances pour 2023");
  assert.equal(franceConseilOmissionExceptionFor(2022, "DC", FRANCE_CONSEIL_POLICY_VERSION_V2), FRANCE_CONSEIL_V2_E1_EXCEPTION);
  const item = buildFranceConseilOmissionItem({
    year: 2022,
    documentType: "DC",
    policyVersion: FRANCE_CONSEIL_POLICY_VERSION_V2,
    dilaAbsenceScan: { identityHits: 0, norHits: 0, ecliHits: 0 },
    exception: FRANCE_CONSEIL_V2_E1_EXCEPTION,
    conseil: {
      expectedCount: 1,
      items: [{
        stableItemKey: "conseil:2022847dc",
        sourceRecordId: "2022847DC",
        discoveredUrl: FRANCE_CONSEIL_V2_E1_EXCEPTION.authorityUrl,
        documentType: "DC",
        decisionDateHint: "2022-12-29",
        title: "Décision n° 2022-847 DC du 29 décembre 2022",
      }],
    },
    authorityEvidence: {
      canonicalUrl: FRANCE_CONSEIL_V2_E1_EXCEPTION.authorityUrl,
      pageTitle: "Décision n° 2022-847 DC du 29 décembre 2022",
      description: "Loi de finances pour 2023",
      ecli: FRANCE_CONSEIL_V2_E1_EXCEPTION.conseil.ecli,
      jorf: FRANCE_CONSEIL_V2_E1_EXCEPTION.conseil.jorf,
    },
    stockProvenance: STOCK_PROVENANCE,
    incrementCount: 21,
    memberScanCount: 7600,
    observedAt: OBSERVED_AT,
  });
  assert.equal(item.stableItemKey, "constit:conseil-omission:2022847dc");
});

test("France v3 migration is additive, exact-tuple gated, and keeps v1/v2 immutable", () => {
  assert.match(policyV3Migration, /france-dila-constit-2026-09-v3/);
  assert.match(policyV3Migration, /supersedes_policy_version[\s\S]*france-dila-constit-2026-09-v2/);
  assert.match(policyV3Migration, /FRANCE_CONSTIT_POLICY_V3_APPROVAL_CONFLICT/);
  assert.match(policyV3Migration, /create or replace function france_conseil_omission_exceptions_v1/);
  assert.match(policyV3Migration, /create or replace function france_conseil_omission_metadata_valid_v1/);
  assert.match(policyV3Migration, /create or replace function source_inventory_item_upsert_v3/);
  assert.match(policyV3Migration, /return source_inventory_item_upsert_v2\(/);
  assert.match(policyV3Migration, /revoke execute on function source_inventory_item_upsert_v2[\s\S]*from service_role/);
  assert.match(policyV3Migration, /grant execute on function source_inventory_item_upsert_v3[\s\S]*to service_role/);
  assert.match(policyV3Migration, /create or replace function case_catalog_france_inventory_attribution_valid_v3/);
  assert.match(policyV3Migration, /case_catalog_france_public_attribution_guard_v3/);
  assert.match(policyV3Migration, /case_catalog_france_public_attribution_guard_trigger/);
  for (const id of ["2016613QPC", "2017663QPC", "2017664QPC", "2017665QPC", "2017666QPC", "2017670QPC"]) {
    assert.match(policyV3Migration, new RegExp(id));
  }
});
