import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import {
  FRANCE_CONSEIL_APPROVED_POLICY_VERSION,
  FRANCE_CONSEIL_POLICY_VERSION_V1,
  FRANCE_CONSEIL_POLICY_VERSION_V2,
  FRANCE_CONSEIL_V2_E1_EXCEPTION,
  FRANCE_CONSEIL_V2_E2_EXCEPTION,
  franceConseilApprovedPolicyDescriptor,
  franceConseilDilaCanonicalizationsFor,
  franceConseilOmissionExceptionFor,
  franceConseilPolicyVersionRecognized,
  type FranceConseilDilaCanonicalizationException,
  type FranceConseilDocumentType,
} from "../lib/backfill/france-scope";
import {
  DILA_CONSTIT_DIRECTORY_URL,
  buildFranceConseilOmissionItem,
  discoverFranceDilaConstitInventory,
  overlayDilaConstitRecords,
} from "../lib/crawlee/france-dila-constit";
import type {
  DilaConstitArchiveProvenance,
  DilaConstitRecord,
} from "../lib/crawlee/france-dila-constit";
import type { FranceConseilInventoryResult } from "../lib/crawlee/france-conseil-inventory";
import { loadCaseBackfillSourceStrategy } from "../lib/backfill/source-strategies";

function migration(name: string) {
  return fs.readFileSync(path.join(process.cwd(), "supabase/migrations", name), "utf8");
}

const policyV2Migration = migration("20260916100000_constitutional_case_france_policy_v2_approval.sql");
const upsertV3Migration = migration("20260916101000_constitutional_case_france_inventory_provenance_v3.sql");
const attributionV2Migration = migration("20260916102000_constitutional_case_france_public_attribution_v2.sql");

function provenance(
  kind: "stock" | "increment",
  order: number,
  filename: string,
): DilaConstitArchiveProvenance {
  return {
    kind,
    order,
    filename,
    url: `https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/${filename}`,
    extractedAt: order === 0
      ? "2025-07-13T14:00:00.000Z"
      : `2025-07-${String(14 + order).padStart(2, "0")}T21:19:07.000Z`,
    lastModified: null,
    etag: null,
    contentLength: 1024,
    sha256: "a".repeat(64),
  };
}

function dilaRecord(input: {
  id: string;
  record: string;
  nature?: string;
  date?: string;
  number?: string;
  nor?: string;
  title?: string;
  ecli?: string;
}): DilaConstitRecord {
  const nature = input.nature ?? "QPC";
  const date = input.date ?? "2022-01-07";
  const number = input.number ?? "2022-1001";
  return {
    dilaId: input.id,
    nature,
    qualifiedNature: nature,
    title: input.title ?? `Décision ${number}`,
    decisionDate: date,
    decisionNumber: number,
    ecli: input.ecli ?? `ECLI:FR:CC:${date.slice(0, 4)}:${number}.${nature}`,
    canonicalUrl: `https://www.conseil-constitutionnel.fr/decision/${date.slice(0, 4)}/${input.record}.htm`,
    conseilRecordId: input.record,
    archiveMemberPath: `constit/global/CONS/TEXT/00/00/${input.id.slice(-2)}/${input.id}.xml`,
    ...(input.nor ? { nor: input.nor } : {}),
  };
}

const STOCK_PROVENANCE = {
  filename: "Freemium_constit_global_20250713-140000.tar.gz",
  sha256: "67270556060b481ec139f21436244af913cccd3eb6e074c65d6600f48596f627",
};

function nearMissE2(overrides: Record<string, string>): FranceConseilDilaCanonicalizationException {
  return { ...FRANCE_CONSEIL_V2_E2_EXCEPTION, ...overrides } as unknown as FranceConseilDilaCanonicalizationException;
}

function conseilInventory(
  items: Array<{ id: string; date: string; title: string }>,
  documentType: FranceConseilDocumentType = "QPC",
): FranceConseilInventoryResult {
  return {
    sourceKey: "fr-conseil-constitutionnel",
    year: 2022,
    documentType,
    expectedCount: items.length,
    pageCount: 1,
    items: items.map((entry) => ({
      stableItemKey: `conseil:${entry.id.toLowerCase()}`,
      sourceRecordId: entry.id,
      discoveredUrl: `https://www.conseil-constitutionnel.fr/decision/${entry.date.slice(0, 4)}/${entry.id}.htm`,
      documentType: entry.id.toUpperCase().endsWith("DC") ? "DC" : "QPC",
      decisionDateHint: entry.date,
      title: entry.title,
    })),
    coverageEvidence: { method: "official_conseil_annual_type_pagination" },
  };
}

test("France v2 policy metadata recognizes exactly v1 and v2 and keeps the approved scope", () => {
  assert.equal(FRANCE_CONSEIL_APPROVED_POLICY_VERSION, "france-dila-constit-2026-09-v2");
  assert.equal(FRANCE_CONSEIL_POLICY_VERSION_V1, "france-dila-constit-2026-09-v1");
  assert.equal(FRANCE_CONSEIL_POLICY_VERSION_V2, "france-dila-constit-2026-09-v2");
  assert.equal(franceConseilPolicyVersionRecognized(FRANCE_CONSEIL_POLICY_VERSION_V1), true);
  assert.equal(franceConseilPolicyVersionRecognized(FRANCE_CONSEIL_POLICY_VERSION_V2), true);
  assert.equal(franceConseilPolicyVersionRecognized("france-dila-constit-2026-09-v3"), false);
  assert.equal(franceConseilPolicyVersionRecognized(null), false);
  assert.deepEqual(franceConseilApprovedPolicyDescriptor(), {
    policyVersion: FRANCE_CONSEIL_POLICY_VERSION_V2,
    supersedesPolicyVersion: FRANCE_CONSEIL_POLICY_VERSION_V1,
    priorPolicyVersions: [FRANCE_CONSEIL_POLICY_VERSION_V1],
    reviewDueAt: "2027-03-15",
    documentTypes: ["QPC", "DC"],
    approvedYearFrom: 2010,
    approvedYearTo: 2024,
    historyStartYear: 2010,
    historicalMaxYear: 2024,
  });
});

test("France v2 exceptions are exact-literal and policy-version gated with no wildcard fallback", () => {
  assert.equal(franceConseilOmissionExceptionFor(2022, "DC", FRANCE_CONSEIL_POLICY_VERSION_V2), FRANCE_CONSEIL_V2_E1_EXCEPTION);
  // v1 never applies E1.
  assert.equal(franceConseilOmissionExceptionFor(2022, "DC", FRANCE_CONSEIL_POLICY_VERSION_V1), null);
  assert.equal(franceConseilOmissionExceptionFor(2022, "DC", null), null);
  // No wildcard/general "DILA missing => Conseil": every near-miss is rejected.
  for (const year of [2010, 2021, 2023, 2024]) {
    assert.equal(franceConseilOmissionExceptionFor(year, "DC", FRANCE_CONSEIL_POLICY_VERSION_V2), null, String(year));
  }
  assert.equal(franceConseilOmissionExceptionFor(2022, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V2), null);
  assert.equal(franceConseilOmissionExceptionFor(2022, "L", FRANCE_CONSEIL_POLICY_VERSION_V2), null);

  assert.deepEqual(
    franceConseilDilaCanonicalizationsFor(2022, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V2),
    [FRANCE_CONSEIL_V2_E2_EXCEPTION],
  );
  assert.deepEqual(franceConseilDilaCanonicalizationsFor(2022, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V1), []);
  assert.deepEqual(franceConseilDilaCanonicalizationsFor(2022, "QPC", null), []);
  assert.deepEqual(franceConseilDilaCanonicalizationsFor(2021, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V2), []);
  assert.deepEqual(franceConseilDilaCanonicalizationsFor(2022, "DC", FRANCE_CONSEIL_POLICY_VERSION_V2), []);

  assert.equal(FRANCE_CONSEIL_V2_E1_EXCEPTION.stableItemKey, "constit:conseil-omission:2022847dc");
  assert.equal(FRANCE_CONSEIL_V2_E1_EXCEPTION.reasonCode, "dila_omission_verified_absent");
  assert.equal(FRANCE_CONSEIL_V2_E1_EXCEPTION.conseil.nor, "CSCL2237744S");
  assert.equal(FRANCE_CONSEIL_V2_E2_EXCEPTION.canonicalDilaId, "CONSTEXT000047955984");
  assert.equal(FRANCE_CONSEIL_V2_E2_EXCEPTION.retiredDilaId, "CONSTEXT000046216504");
  assert.equal(
    FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilTitle,
    "A.N., Français établis hors de France (2ème circ.), M. Christian RODRIGUEZ [ ]",
  );
  assert.equal(FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilEcli, "ECLI:FR:CC:2022:2022.5813.AN.QPC");
});

test("France v2 E2 canonicalizes only the exact ordered pair and records retirement evidence", () => {
  const stock = provenance("stock", 0, STOCK_PROVENANCE.filename);
  const canonical = dilaRecord({
    id: FRANCE_CONSEIL_V2_E2_EXCEPTION.canonicalDilaId,
    record: "20225813AN_QPC",
    date: "2022-07-29",
    number: "2022-5813 AN /",
    title: FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilTitle,
    ecli: FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilEcli,
  });
  const retired = dilaRecord({
    id: FRANCE_CONSEIL_V2_E2_EXCEPTION.retiredDilaId,
    record: "20225813AN_QPC",
    date: "2022-07-29",
    number: "2022-5813 AN /",
    title: "A.N., Français établis hors de France (2ème circ.), M. Christian RODRIGUEZ",
    ecli: "ECLI:FR:CC:2022:2022.5813AN.QPC",
  });
  const evidence = authorityEvidence({
    url: "https://www.conseil-constitutionnel.fr/decision/2022/20225813AN_QPC.htm",
    pageTitle: "Décision n° 2022-5813 AN / QPC du 29 juillet 2022",
    description: FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilTitle,
    ecli: FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilEcli,
  });
  const result = overlayDilaConstitRecords({
    stock: { provenance: stock, records: [canonical, retired] },
    increments: [],
    scope: { year: 2022, documentType: "QPC" },
    canonicalizations: [FRANCE_CONSEIL_V2_E2_EXCEPTION],
    canonicalizationAuthorityEvidence: new Map([["20225813an_qpc", evidence]]),
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].record.dilaId, FRANCE_CONSEIL_V2_E2_EXCEPTION.canonicalDilaId);
  assert.deepEqual(result.retirements, [{
    retiredDilaId: FRANCE_CONSEIL_V2_E2_EXCEPTION.retiredDilaId,
    canonicalDilaId: FRANCE_CONSEIL_V2_E2_EXCEPTION.canonicalDilaId,
    conseilRecordId: FRANCE_CONSEIL_V2_E2_EXCEPTION.conseilRecordId,
    basis: FRANCE_CONSEIL_V2_E2_EXCEPTION.basis,
    corroborationRef: "matches_current_conseil_title_and_ecli",
  }]);
});

test("France v2 E2 reversed, different, or extra duplicates still fail closed", () => {
  const stock = provenance("stock", 0, STOCK_PROVENANCE.filename);
  const canonical = dilaRecord({
    id: FRANCE_CONSEIL_V2_E2_EXCEPTION.canonicalDilaId,
    record: "20225813AN_QPC",
    date: "2022-07-29",
    number: "2022-5813 AN /",
    title: FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilTitle,
    ecli: FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilEcli,
  });
  const retired = dilaRecord({
    id: FRANCE_CONSEIL_V2_E2_EXCEPTION.retiredDilaId,
    record: "20225813AN_QPC",
    date: "2022-07-29",
    number: "2022-5813 AN /",
    title: "A.N., Français établis hors de France (2ème circ.), M. Christian RODRIGUEZ",
    ecli: "ECLI:FR:CC:2022:2022.5813AN.QPC",
  });
  const base = {
    stock: { provenance: stock, records: [canonical, retired] },
    increments: [],
    scope: { year: 2022, documentType: "QPC" as const },
  };
  // Reversed direction is not the frozen pair.
  assert.throws(
    () => overlayDilaConstitRecords({
      ...base,
      canonicalizations: [nearMissE2({
        canonicalDilaId: FRANCE_CONSEIL_V2_E2_EXCEPTION.retiredDilaId,
        retiredDilaId: FRANCE_CONSEIL_V2_E2_EXCEPTION.canonicalDilaId,
      })],
    }),
    /france_dila_conseil_identity_duplicate/,
  );
  // A different canonical DILA ID is not the frozen pair.
  assert.throws(
    () => overlayDilaConstitRecords({
      ...base,
      canonicalizations: [nearMissE2({ canonicalDilaId: "CONSTEXT000099999999" })],
    }),
    /france_dila_conseil_identity_duplicate/,
  );
  // A different Conseil record must not be canonicalized.
  assert.throws(
    () => overlayDilaConstitRecords({
      ...base,
      canonicalizations: [nearMissE2({ conseilRecordId: "20225814AN_QPC" })],
    }),
    /france_dila_conseil_identity_duplicate/,
  );
  // Any extra duplicate beyond the exact ordered pair remains fail-closed.
  const third = dilaRecord({
    id: "CONSTEXT000099999999",
    record: "20225813AN_QPC",
    number: "2022-5813 AN /",
  });
  assert.throws(
    () => overlayDilaConstitRecords({
      stock: { provenance: stock, records: [canonical, retired, third] },
      increments: [],
      scope: { year: 2022, documentType: "QPC" },
      canonicalizations: [FRANCE_CONSEIL_V2_E2_EXCEPTION],
    }),
    /france_dila_conseil_identity_duplicate/,
  );
  // v1 regression: the exact pair still fails closed without the v2 exception.
  assert.throws(
    () => overlayDilaConstitRecords(base),
    /france_dila_conseil_identity_duplicate:20225813an_qpc/,
  );
});

test("France v2 E2 requires frozen current Conseil title and ECLI corroboration", () => {
  const stock = provenance("stock", 0, STOCK_PROVENANCE.filename);
  const canonical = dilaRecord({
    id: FRANCE_CONSEIL_V2_E2_EXCEPTION.canonicalDilaId,
    record: FRANCE_CONSEIL_V2_E2_EXCEPTION.conseilRecordId,
    date: "2022-07-29",
    number: "2022-5813 AN /",
    title: FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilTitle,
    ecli: FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilEcli,
  });
  const retired = dilaRecord({
    id: FRANCE_CONSEIL_V2_E2_EXCEPTION.retiredDilaId,
    record: FRANCE_CONSEIL_V2_E2_EXCEPTION.conseilRecordId,
    date: "2022-07-29",
    number: "2022-5813 AN /",
    title: "A.N., Français établis hors de France (2ème circ.), M. Christian RODRIGUEZ",
    ecli: "ECLI:FR:CC:2022:2022.5813AN.QPC",
  });
  const base = {
    stock: { provenance: stock, records: [canonical, retired] },
    increments: [],
    scope: { year: 2022, documentType: "QPC" as const },
    canonicalizations: [FRANCE_CONSEIL_V2_E2_EXCEPTION],
  };
  assert.throws(
    () => overlayDilaConstitRecords(base),
    /france_dila_canonicalization_corroboration_missing/,
  );
  const url = "https://www.conseil-constitutionnel.fr/decision/2022/20225813AN_QPC.htm";
  assert.throws(
    () => overlayDilaConstitRecords({
      ...base,
      canonicalizationAuthorityEvidence: new Map([["20225813an_qpc", authorityEvidence({
        url,
        pageTitle: "Décision n° 2022-5813 AN / QPC du 29 juillet 2022",
        description: `${FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilTitle} changed`,
        ecli: FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilEcli,
      })]]),
    }),
    /france_dila_canonicalization_corroboration_drift:title/,
  );
  assert.throws(
    () => overlayDilaConstitRecords({
      ...base,
      canonicalizationAuthorityEvidence: new Map([["20225813an_qpc", authorityEvidence({
        url,
        pageTitle: "Décision n° 2022-5813 AN / QPC du 29 juillet 2022",
        description: FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilTitle,
        ecli: "ECLI:FR:CC:2022:2022.5813.WRONG.QPC",
      })]]),
    }),
    /france_dila_canonicalization_corroboration_drift:ecli/,
  );
});

test("France v2 E1 builds the exact Conseil-provider omission item with per-discover absence evidence", () => {
  const detail = authorityEvidence({
    url: FRANCE_CONSEIL_V2_E1_EXCEPTION.authorityUrl,
    pageTitle: "Décision n° 2022-847 DC du 29 décembre 2022",
    description: "Loi de finances pour 2023",
    ecli: FRANCE_CONSEIL_V2_E1_EXCEPTION.conseil.ecli,
    jorf: FRANCE_CONSEIL_V2_E1_EXCEPTION.conseil.jorf,
  });
  const item = buildFranceConseilOmissionItem({
    year: 2022,
    documentType: "DC",
    policyVersion: FRANCE_CONSEIL_POLICY_VERSION_V2,
    dilaAbsenceScan: { identityHits: 0, norHits: 0 },
    conseil: conseilInventory([{
      id: "2022847DC",
      date: "2022-12-29",
      title: "Décision n° 2022-847 DC du 29 décembre 2022",
    }]),
    authorityEvidence: detail,
    stockProvenance: STOCK_PROVENANCE,
    incrementCount: 21,
    memberScanCount: 1234,
    observedAt: "2026-09-16T12:00:00.000Z",
  });
  assert.equal(item.stableItemKey, "constit:conseil-omission:2022847dc");
  assert.equal(item.sourceRecordId, "2022847DC");
  assert.equal(item.discoveredUrl, FRANCE_CONSEIL_V2_E1_EXCEPTION.authorityUrl);
  assert.equal(item.documentType, "DC");
  assert.equal(item.decisionDateHint, "2022-12-29");
  assert.equal(item.dilaId, undefined);
  assert.equal(item.archiveMemberPath, undefined);
  assert.deepEqual(item.inventoryMetadata, {
    provider: "conseil",
    reasonCode: "dila_omission_verified_absent",
    authorityUrl: FRANCE_CONSEIL_V2_E1_EXCEPTION.authorityUrl,
    conseil: {
      sourceRecordId: "2022847DC",
      canonicalUrl: FRANCE_CONSEIL_V2_E1_EXCEPTION.authorityUrl,
      ecli: "ECLI:FR:CC:2022:2022.847.DC",
      decisionNumber: "2022-847",
      decisionDate: "2022-12-29",
      jorf: "JORF n°0303 du 31 décembre 2022, texte n° 2",
      nor: "CSCL2237744S",
      authorityObservedAt: "2026-09-16T12:00:00.000Z",
      authorityTitle: "Décision n° 2022-847 DC du 29 décembre 2022",
      authorityDescription: "Loi de finances pour 2023",
    },
    dilaLookup: {
      stockFilename: STOCK_PROVENANCE.filename,
      stockSha256: STOCK_PROVENANCE.sha256,
      incrementsApplied: 21,
      memberScanCount: 1234,
      sourceRecordIdSearched: "2022847DC",
      norSearched: "CSCL2237744S",
      identityHits: 0,
      norHits: 0,
      result: "absent",
      observedAt: "2026-09-16T12:00:00.000Z",
    },
    license: {
      id: "conseil-official-decision",
      url: FRANCE_CONSEIL_V2_E1_EXCEPTION.authorityUrl,
      attribution: "Conseil constitutionnel",
    },
  });
  assert.equal("dila" in item.inventoryMetadata, false);
});

test("France v2 E1 fails closed on stale DILA presence, corroboration drift, and wrong policy tuple", () => {
  const detail = authorityEvidence({
    url: FRANCE_CONSEIL_V2_E1_EXCEPTION.authorityUrl,
    pageTitle: "Décision n° 2022-847 DC du 29 décembre 2022",
    description: "Loi de finances pour 2023",
    ecli: FRANCE_CONSEIL_V2_E1_EXCEPTION.conseil.ecli,
    jorf: FRANCE_CONSEIL_V2_E1_EXCEPTION.conseil.jorf,
  });
  const base = {
    year: 2022,
    documentType: "DC" as const,
    policyVersion: FRANCE_CONSEIL_POLICY_VERSION_V2,
    stockProvenance: STOCK_PROVENANCE,
    incrementCount: 21,
    memberScanCount: 10,
    observedAt: "2026-09-16T12:00:00.000Z",
    dilaAbsenceScan: { identityHits: 0, norHits: 0 },
    authorityEvidence: detail,
    conseil: conseilInventory([{
      id: "2022847DC",
      date: "2022-12-29",
      title: "Décision n° 2022-847 DC du 29 décembre 2022",
    }]),
  };
  // The identity later appears in the effective DILA corpus -> stale.
  assert.throws(
    () => buildFranceConseilOmissionItem({
      ...base,
      dilaAbsenceScan: { identityHits: 1, norHits: 0 },
    }),
    /france_conseil_omission_stale:identity_present_in_dila/,
  );
  // The same NOR appearing under a different DILA identity is also stale.
  assert.throws(
    () => buildFranceConseilOmissionItem({
      ...base,
      dilaAbsenceScan: { identityHits: 0, norHits: 1 },
    }),
    /france_conseil_omission_stale:identity_present_in_dila/,
  );
  // Disappears from the official Conseil facet -> no synthesis.
  assert.throws(
    () => buildFranceConseilOmissionItem({
      ...base,
      conseil: conseilInventory([{ id: "2022848DC", date: "2022-12-29", title: "Décision n° 2022-848 DC du 29 décembre 2022" }]),
    }),
    /france_conseil_omission_corroboration_missing/,
  );
  // Authority URL drift.
  assert.throws(
    () => buildFranceConseilOmissionItem({
      ...base,
      conseil: {
        expectedCount: 1,
        items: [{
          stableItemKey: "conseil:2022847dc",
          sourceRecordId: "2022847DC",
          discoveredUrl: "https://www.conseil-constitutionnel.fr/decision/2022/2022847DC.html",
          documentType: "DC",
          decisionDateHint: "2022-12-29",
          title: "Décision n° 2022-847 DC du 29 décembre 2022",
        }],
      },
    }),
    /france_conseil_omission_corroboration_drift:authority_url/,
  );
  // Decision date drift.
  assert.throws(
    () => buildFranceConseilOmissionItem({
      ...base,
      conseil: conseilInventory([{ id: "2022847DC", date: "2022-12-30", title: "Décision n° 2022-847 DC du 30 décembre 2022" }]),
    }),
    /france_conseil_omission_corroboration_drift:decision_date/,
  );
  // Title decision-number drift.
  assert.throws(
    () => buildFranceConseilOmissionItem({
      ...base,
      conseil: conseilInventory([{ id: "2022847DC", date: "2022-12-29", title: "Décision n° 2022-999 DC du 29 décembre 2022" }]),
    }),
    /france_conseil_omission_corroboration_drift:decision_number/,
  );
  // Wrong policy version can never enable the fallback.
  for (const policyVersion of [FRANCE_CONSEIL_POLICY_VERSION_V1, null, undefined]) {
    assert.throws(
      () => buildFranceConseilOmissionItem({ ...base, policyVersion }),
      /france_conseil_omission_not_enabled/,
    );
  }
});

function dilaXml(input: {
  id: string;
  nature: string;
  date: string;
  number: string;
  record: string;
  title?: string;
  nor?: string;
  ecli?: string;
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<TEXTE_JURI_CONSTIT><META><META_COMMUN>
<ID>${input.id}</ID><ORIGINE>CONSTIT</ORIGINE><NATURE>${input.nature}</NATURE>
</META_COMMUN><META_SPEC><META_JURI>
<TITRE>${input.title ?? `Décision ${input.number}`}</TITRE><DATE_DEC>${input.date}</DATE_DEC>
<JURIDICTION>Conseil constitutionnel</JURIDICTION><NUMERO>${input.number}</NUMERO>
${input.nor ? `<NOR>${input.nor}</NOR>` : ""}
</META_JURI><META_JURI_CONSTIT>
<NATURE_QUALIFIEE>${input.nature}</NATURE_QUALIFIEE>
<URL_CC>http://www.conseil-constitutionnel.fr/decision/${input.date.slice(0, 4)}/${input.record}.htm</URL_CC>
<ECLI>${input.ecli ?? `ECLI:FR:CC:${input.date.slice(0, 4)}:${input.number}.${input.nature}`}</ECLI>
</META_JURI_CONSTIT></META_SPEC></META><TEXTE><BLOC_TEXTUEL><CONTENU>Texte officiel.</CONTENU></BLOC_TEXTUEL></TEXTE>
</TEXTE_JURI_CONSTIT>`;
}

function authorityEvidence(input: {
  url: string;
  pageTitle: string;
  description: string;
  ecli: string;
  jorf?: string | null;
}) {
  return {
    canonicalUrl: input.url,
    pageTitle: input.pageTitle,
    description: input.description,
    ecli: input.ecli,
    jorf: input.jorf ?? null,
  };
}

function authorityHtml(input: {
  url: string;
  pageTitle: string;
  description: string;
  ecli: string;
  jorf?: string | null;
}) {
  return `<!doctype html><html><head>
<link rel="canonical" href="${input.url}">
<meta property="og:title" content="${input.pageTitle}">
<meta name="description" content="${input.description}">
</head><body><h1 class="title">${input.pageTitle}</h1>
<p>${input.jorf ? `${input.jorf}<br>` : ""}ECLI : ${input.ecli.replace(/^ECLI:/, "").replace(/:/g, " : ")}</p>
</body></html>`;
}

function tarEntry(name: string, content: string) {
  const body = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(32, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}

function dilaArchive(entries: Array<{ name: string; xml: string }>) {
  return zlib.gzipSync(Buffer.concat([
    ...entries.map((entry) => tarEntry(entry.name, entry.xml)),
    Buffer.alloc(1024),
  ]));
}

async function withStockFetch<T>(
  stockName: string,
  stockArchive: Buffer,
  authorityPages: Record<string, string>,
  run: () => Promise<T>,
) {
  const previousRobots = process.env.CRAWLER_ROBOTS_ENABLED;
  const previousDelay = process.env.FRANCE_REQUEST_DELAY_MS;
  process.env.CRAWLER_ROBOTS_ENABLED = "false";
  process.env.FRANCE_REQUEST_DELAY_MS = "0";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const respond = (body: Uint8Array | string, contentType: string) => {
      const response = new Response(body as BodyInit, { status: 200, headers: { "content-type": contentType } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    if (url === DILA_CONSTIT_DIRECTORY_URL) return respond(`<a href="${stockName}">stock</a>`, "text/html");
    if (url.endsWith(stockName)) return respond(stockArchive, "application/gzip");
    if (authorityPages[url]) return respond(authorityPages[url], "text/html");
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
    if (previousRobots === undefined) delete process.env.CRAWLER_ROBOTS_ENABLED;
    else process.env.CRAWLER_ROBOTS_ENABLED = previousRobots;
    if (previousDelay === undefined) delete process.env.FRANCE_REQUEST_DELAY_MS;
    else process.env.FRANCE_REQUEST_DELAY_MS = previousDelay;
  }
}

test("France v2 discovery applies E2 and keeps v1 fail-closed for the same corpus", async () => {
  const stockName = "Freemium_constit_global_20250713-140000.tar.gz";
  const root = "constit/global/CONS/TEXT/00/00/";
  const archive = dilaArchive([
    {
      name: `${root}CONSTEXT000047955984.xml`,
      xml: dilaXml({
        id: "CONSTEXT000047955984",
        nature: "QPC",
        date: "2022-07-29",
        number: "2022-5813 AN /",
        record: "20225813AN_QPC",
        title: FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilTitle,
        ecli: FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilEcli,
      }),
    },
    {
      name: `${root}CONSTEXT000046216504.xml`,
      xml: dilaXml({
        id: "CONSTEXT000046216504",
        nature: "QPC",
        date: "2022-07-29",
        number: "2022-5813 AN /",
        record: "20225813AN_QPC",
        title: "A.N., Français établis hors de France (2ème circ.), M. Christian RODRIGUEZ",
        ecli: "ECLI:FR:CC:2022:2022.5813AN.QPC",
      }),
    },
    {
      name: `${root}CONSTEXT000050000001.xml`,
      xml: dilaXml({ id: "CONSTEXT000050000001", nature: "QPC", date: "2022-02-01", number: "2022-1002", record: "20221002QPC" }),
    },
  ]);
  const conseil = conseilInventory([
    { id: "20225813AN_QPC", date: "2022-07-29", title: "Décision n° 2022-5813 AN / QPC du 29 juillet 2022" },
    { id: "20221002QPC", date: "2022-02-01", title: "Décision n° 2022-1002 QPC du 1er février 2022" },
  ]);
  const e2Url = "https://www.conseil-constitutionnel.fr/decision/2022/20225813AN_QPC.htm";
  const pages = {
    [e2Url]: authorityHtml({
      url: e2Url,
      pageTitle: "Décision n° 2022-5813 AN / QPC du 29 juillet 2022",
      description: FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilTitle,
      ecli: FRANCE_CONSEIL_V2_E2_EXCEPTION.expectedConseilEcli,
    }),
  };
  await withStockFetch(stockName, archive, pages, async () => {
    const v2 = await discoverFranceDilaConstitInventory({
      year: 2022,
      documentType: "QPC",
      policyVersion: FRANCE_CONSEIL_POLICY_VERSION_V2,
      currentYear: 2026,
      discoverConseilInventory: async () => conseil,
    });
    assert.deepEqual(v2.items.map((item) => item.sourceRecordId).sort(), ["20221002QPC", "20225813AN_QPC"]);
    const canonicalItem = v2.items.find((item) => item.sourceRecordId === "20225813AN_QPC");
    assert.equal(canonicalItem?.stableItemKey, "constit:constext000047955984");
    assert.equal(
      ((canonicalItem?.inventoryMetadata.dila as Record<string, unknown>).retirement as Record<string, unknown>).retiredDilaId,
      "CONSTEXT000046216504",
    );
    assert.deepEqual(v2.coverageEvidence.exceptions, {
      policyVersion: FRANCE_CONSEIL_POLICY_VERSION_V2,
      appliedExceptionIds: ["e2_dila_canonicalization"],
      omissionFallbackItemCount: 0,
      canonicalizationCount: 1,
    });

    await assert.rejects(
      discoverFranceDilaConstitInventory({
        year: 2022,
        documentType: "QPC",
        policyVersion: FRANCE_CONSEIL_POLICY_VERSION_V1,
        currentYear: 2026,
        discoverConseilInventory: async () => conseil,
      }),
      /france_dila_conseil_identity_duplicate/,
    );
  });
});

test("France v2 discovery synthesizes E1 for 2022 DC and fails stale when DILA later contains it", async () => {
  const stockName = "Freemium_constit_global_20250713-140000.tar.gz";
  const root = "constit/global/CONS/TEXT/00/00/";
  const baseArchive = dilaArchive([
    {
      name: `${root}CONSTEXT000050000010.xml`,
      xml: dilaXml({ id: "CONSTEXT000050000010", nature: "DC", date: "2022-12-15", number: "2022-846", record: "2022846DC" }),
    },
  ]);
  const staleArchive = dilaArchive([
    {
      name: `${root}CONSTEXT000050000010.xml`,
      xml: dilaXml({ id: "CONSTEXT000050000010", nature: "DC", date: "2022-12-15", number: "2022-846", record: "2022846DC" }),
    },
    {
      name: `${root}CONSTEXT000050000011.xml`,
      xml: dilaXml({ id: "CONSTEXT000050000011", nature: "DC", date: "2022-12-29", number: "2022-847", record: "2022847DC" }),
    },
  ]);
  const conseil = conseilInventory([
    { id: "2022846DC", date: "2022-12-15", title: "Décision n° 2022-846 DC du 15 décembre 2022" },
    { id: "2022847DC", date: "2022-12-29", title: "Décision n° 2022-847 DC du 29 décembre 2022" },
  ]);
  const e1Url = FRANCE_CONSEIL_V2_E1_EXCEPTION.authorityUrl;
  const pages = {
    [e1Url]: authorityHtml({
      url: e1Url,
      pageTitle: "Décision n° 2022-847 DC du 29 décembre 2022",
      description: "Loi de finances pour 2023",
      ecli: FRANCE_CONSEIL_V2_E1_EXCEPTION.conseil.ecli,
      jorf: FRANCE_CONSEIL_V2_E1_EXCEPTION.conseil.jorf,
    }),
  };
  await withStockFetch(stockName, baseArchive, pages, async () => {
    const v2 = await discoverFranceDilaConstitInventory({
      year: 2022,
      documentType: "DC",
      policyVersion: FRANCE_CONSEIL_POLICY_VERSION_V2,
      currentYear: 2026,
      discoverConseilInventory: async () => conseil,
    });
    const omission = v2.items.find((item) => item.stableItemKey === "constit:conseil-omission:2022847dc");
    assert.ok(omission);
    assert.equal(omission.dilaId, undefined);
    assert.deepEqual(v2.coverageEvidence.exceptions, {
      policyVersion: FRANCE_CONSEIL_POLICY_VERSION_V2,
      appliedExceptionIds: ["e1_conseil_provider_fallback"],
      omissionFallbackItemCount: 1,
      canonicalizationCount: 0,
    });

    await assert.rejects(
      discoverFranceDilaConstitInventory({
        year: 2022,
        documentType: "DC",
        policyVersion: FRANCE_CONSEIL_POLICY_VERSION_V1,
        currentYear: 2026,
        discoverConseilInventory: async () => conseil,
      }),
      /france_inventory_identity_mismatch/,
    );
  });

  await withStockFetch(stockName, staleArchive, pages, async () => {
    await assert.rejects(
      discoverFranceDilaConstitInventory({
        year: 2022,
        documentType: "DC",
        policyVersion: FRANCE_CONSEIL_POLICY_VERSION_V2,
        currentYear: 2026,
        discoverConseilInventory: async () => conseil,
      }),
      /france_conseil_omission_stale:identity_present_in_dila/,
    );
  });
});

test("France v2 E1 raw absence scan catches the approved NOR even inside a non-QPC/DC XML member", async () => {
  const stockName = "Freemium_constit_global_20250713-140000.tar.gz";
  const root = "constit/global/CONS/TEXT/00/00/";
  const archive = dilaArchive([
    {
      name: `${root}CONSTEXT000050000010.xml`,
      xml: dilaXml({ id: "CONSTEXT000050000010", nature: "DC", date: "2022-12-15", number: "2022-846", record: "2022846DC" }),
    },
    {
      name: `${root}CONSTEXT000050000099.xml`,
      xml: dilaXml({
        id: "CONSTEXT000050000099",
        nature: "L",
        date: "2022-11-01",
        number: "2022-999 L",
        record: "2022999L",
        nor: FRANCE_CONSEIL_V2_E1_EXCEPTION.conseil.nor,
      }),
    },
  ]);
  const conseil = conseilInventory([
    { id: "2022846DC", date: "2022-12-15", title: "Décision n° 2022-846 DC du 15 décembre 2022" },
    { id: "2022847DC", date: "2022-12-29", title: "Décision n° 2022-847 DC du 29 décembre 2022" },
  ], "DC");
  const e1Url = FRANCE_CONSEIL_V2_E1_EXCEPTION.authorityUrl;
  await withStockFetch(stockName, archive, {
    [e1Url]: authorityHtml({
      url: e1Url,
      pageTitle: "Décision n° 2022-847 DC du 29 décembre 2022",
      description: "Loi de finances pour 2023",
      ecli: FRANCE_CONSEIL_V2_E1_EXCEPTION.conseil.ecli,
      jorf: FRANCE_CONSEIL_V2_E1_EXCEPTION.conseil.jorf,
    }),
  }, async () => {
    await assert.rejects(
      discoverFranceDilaConstitInventory({
        year: 2022,
        documentType: "DC",
        policyVersion: FRANCE_CONSEIL_POLICY_VERSION_V2,
        currentYear: 2026,
        discoverConseilInventory: async () => conseil,
      }),
      /france_conseil_omission_stale:identity_present_in_dila/,
    );
  });
});

test("France v2 policy migration is additive, conflict-detecting, and supersedes v1", () => {
  assert.match(policyV2Migration, /policy_version = 'france-dila-constit-2026-09-v2'/);
  assert.match(policyV2Migration, /supersedes_policy_version/);
  assert.match(policyV2Migration, /'france-dila-constit-2026-09-v1'/);
  assert.match(policyV2Migration, /FRANCE_CONSTIT_POLICY_V2_APPROVAL_CONFLICT/);
  assert.match(policyV2Migration, /"e1ConseilProviderFallback"/);
  assert.match(policyV2Migration, /"e2DilaCanonicalization"/);
  assert.match(policyV2Migration, /"2022847DC"/);
  assert.match(policyV2Migration, /"CONSTEXT000047955984"/);
  assert.match(policyV2Migration, /"CONSTEXT000046216504"/);
  assert.match(policyV2Migration, /"expectedConseilTitle": "A\.N\., Français établis hors de France/);
  assert.match(policyV2Migration, /"expectedConseilEcli": "ECLI:FR:CC:2022:2022\.5813\.AN\.QPC"/);
  assert.match(policyV2Migration, /WorldCons owner via explicit approval/);
  assert.match(policyV2Migration, /"aiEgress": "denied"/);
  // It must never mutate or delete the v1 row.
  assert.doesNotMatch(policyV2Migration, /update\s+source_corpus_policies/i);
  assert.doesNotMatch(policyV2Migration, /delete\s+from\s+source_corpus_policies/i);
});

test("France v2 inventory upsert is strict, exact-tuple, policy-gated, and keeps v2 intact", () => {
  assert.match(upsertV3Migration, /create or replace function source_inventory_item_upsert_v3/);
  assert.match(upsertV3Migration, /v_snapshot\.source_policy_version\s*<>\s*'france-dila-constit-2026-09-v2'/);
  assert.match(upsertV3Migration, /CASE_BACKFILL_FRANCE_CONSEIL_OMISSION_POLICY_MISMATCH/);
  assert.match(upsertV3Migration, /CASE_BACKFILL_FRANCE_DILA_PROVENANCE_INVALID/);
  assert.match(upsertV3Migration, /return source_inventory_item_upsert_v2\(/);
  assert.match(upsertV3Migration, /'constit:conseil-omission:2022847dc'/);
  assert.match(upsertV3Migration, /'dila_omission_verified_absent'/);
  assert.match(upsertV3Migration, /'CSCL2237744S'/);
  assert.match(upsertV3Migration, /'2022-847'/);
  assert.match(upsertV3Migration, /v_dila_lookup->>'sourceRecordIdSearched' <> '2022847DC'/);
  assert.match(upsertV3Migration, /v_dila_lookup->>'identityHits'\)::integer <> 0/);
  assert.match(upsertV3Migration, /v_dila_lookup->>'norHits'\)::integer <> 0/);
  assert.match(upsertV3Migration, /v_conseil->>'authorityDescription' <> 'Loi de finances pour 2023'/);
  // No fabricated DILA identity or archive member path for the fallback.
  assert.match(upsertV3Migration, /v_metadata \? 'dila'/);
  assert.doesNotMatch(upsertV3Migration, /update source_corpus_policies/i);
});

test("France v2 attribution validator accepts strict DILA or exact E1 and does not enable publication", () => {
  assert.match(attributionV2Migration, /create or replace function case_catalog_france_inventory_attribution_valid_v2/);
  assert.match(attributionV2Migration, /case_catalog_france_inventory_attribution_valid_v1\(p_inventory\)/);
  assert.match(attributionV2Migration, /'france-dila-constit-2026-09-v2'/);
  assert.match(attributionV2Migration, /case_catalog_france_public_attribution_guard_v2/);
  assert.match(attributionV2Migration, /'dila_omission_verified_absent'/);
  assert.match(attributionV2Migration, /'2022847DC'/);
  assert.match(attributionV2Migration, /v_dila_lookup->>'sourceRecordIdSearched' <> '2022847DC'/);
  assert.match(attributionV2Migration, /v_dila_lookup->>'identityHits'\)::integer <> 0/);
  assert.match(attributionV2Migration, /v_dila_lookup->>'norHits'\)::integer <> 0/);
  // Publication must not be enabled by this migration.
  assert.doesNotMatch(attributionV2Migration, /CASE_CATALOG_WRITE_ENABLED|CASE_CATALOG_PUBLIC_ENABLED|CASE_CATALOG_PLUGIN_ENABLED/);
  assert.doesNotMatch(attributionV2Migration, /grant\s+(?:select|insert|update|delete|all)[^;]+\s+to\s+(?:anon|authenticated)/i);
});

test("France source strategy carries the exact snapshot policy version into discovery", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib/backfill/source-strategies.ts"), "utf8");
  assert.match(source, /policyVersion:\s*snapshot\.sourcePolicyVersion/);
  const repository = fs.readFileSync(path.join(process.cwd(), "lib/backfill/repository.ts"), "utf8");
  assert.match(repository, /rpc\("source_inventory_item_upsert_v3"/);
});

test("France v2 rollout readiness stays disabled by default with zero Catalog writes and Gemini calls", async () => {
  const { caseBackfillRolloutReadiness } = await import("../lib/backfill/rollout-readiness");
  const report = caseBackfillRolloutReadiness({
    environment: {},
    currentYear: 2026,
    now: () => new Date("2026-09-16T00:00:00.000Z"),
  });
  const france = report.tranches[1];
  assert.equal(france.policyAuthorized, true);
  assert.equal(france.executionEnabled, false);
  assert.equal(france.policyVersion, FRANCE_CONSEIL_POLICY_VERSION_V2);
  assert.equal(report.catalogWriteEnabled, false);
  assert.equal(report.publicCatalogEnabled, false);
  assert.equal(report.geminiCalls, 0);
  assert.equal(report.approvedSelectionCount, 31);
});
