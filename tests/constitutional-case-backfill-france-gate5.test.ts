import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import zlib from "node:zlib";
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
import {
  parseDilaConstitArchive,
  parseDilaConstitDirectory,
  parseDilaConstitXml,
} from "../lib/crawlee/france-dila-constit";
import {
  createCrawlerNavigationPermitController,
  governedBoundedFetch,
} from "../lib/crawler/request-governor";
import { franceSpiderTransportOptions } from "../lib/sources/conseilconstitutionnel";
import { loadCaseBackfillSourceStrategy } from "../lib/backfill/source-strategies";
import { runOfficialSpider } from "../lib/crawlee/shared";
import { runCaseBackfillPass, validateNormalizedCase } from "../lib/backfill/service";
import type { CaseBackfillRepository } from "../lib/backfill/repository";
import type {
  CaseBackfillAttemptAuthority,
  CaseBackfillPassInput,
  CaseBackfillSnapshot,
} from "../lib/backfill/types";

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

function dilaXml(input: {
  id: string;
  nature: string;
  qualifiedNature?: string;
  date: string;
  number: string;
  record: string;
  title?: string;
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<TEXTE_JURI_CONSTIT><META><META_COMMUN>
<ID>${input.id}</ID><ORIGINE>CONSTIT</ORIGINE><NATURE>${input.nature}</NATURE>
</META_COMMUN><META_SPEC><META_JURI>
<TITRE>${input.title ?? `Décision ${input.number}`}</TITRE><DATE_DEC>${input.date}</DATE_DEC>
<JURIDICTION>Conseil constitutionnel</JURIDICTION><NUMERO>${input.number}</NUMERO>
</META_JURI><META_JURI_CONSTIT>
<NATURE_QUALIFIEE>${input.qualifiedNature ?? input.nature}</NATURE_QUALIFIEE>
<URL_CC>http://www.conseil-constitutionnel.fr/decision/${input.date.slice(0, 4)}/${input.record}.htm</URL_CC>
<ECLI>ECLI:FR:CC:${input.date.slice(0, 4)}:${input.number}.${input.nature}</ECLI>
</META_JURI_CONSTIT></META_SPEC></META><TEXTE><BLOC_TEXTUEL><CONTENU>Texte officiel.</CONTENU></BLOC_TEXTUEL></TEXTE>
</TEXTE_JURI_CONSTIT>`;
}

function tarEntry(name: string, content: string, type = "0") {
  const body = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(32, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}

function dilaArchive(entries: Array<{ name: string; xml: string; type?: string }>) {
  return zlib.gzipSync(Buffer.concat([
    ...entries.map((entry) => tarEntry(entry.name, entry.xml, entry.type)),
    Buffer.alloc(1024),
  ]));
}

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

test("DILA directory parser selects one latest same-origin global stock", () => {
  const stock = parseDilaConstitDirectory(`<a href="Freemium_constit_global_20240101-010203.tar.gz">old</a>
    <a href="/OPENDATA/CONSTIT/Freemium_constit_global_20250713-140000.tar.gz">latest</a>
    <a href="CONSTIT_20250804-220219.tar.gz">increment</a>`);
  assert.deepEqual(stock, {
    filename: "Freemium_constit_global_20250713-140000.tar.gz",
    url: "https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/Freemium_constit_global_20250713-140000.tar.gz",
    extractedAt: "2025-07-13T14:00:00.000Z",
  });
  assert.throws(
    () => parseDilaConstitDirectory(`<a href="https://evil.example/Freemium_constit_global_20250713-140000.tar.gz">stock</a>`),
    /stock_url_invalid/,
  );
  assert.throws(() => parseDilaConstitDirectory("<html>no stock</html>"), /stock_missing/);
});

test("DILA archive uses exact NATURE and preserves official identity provenance", () => {
  const root = "constit/global/CONS/TEXT/00/00/50/00/00/";
  const archive = dilaArchive([
    {
      name: `${root}CONSTEXT000000000001.xml`,
      xml: dilaXml({ id: "CONSTEXT000000000001", nature: "QPC", date: "2024-12-13", number: "2024-1115", record: "20241115QPC" }),
    },
    {
      name: `${root}CONSTEXT000000000002.xml`,
      xml: dilaXml({ id: "CONSTEXT000000000002", nature: "DC", date: "2024-12-12", number: "2024-873", record: "2024873DC" }),
    },
    {
      name: `${root}CONSTEXT000000000003.xml`,
      xml: dilaXml({ id: "CONSTEXT000000000003", nature: "LP", qualifiedNature: "DC05", date: "2024-01-24", number: "2023-8", record: "20238LP" }),
    },
  ]);
  const parsed = parseDilaConstitArchive(archive, { year: 2024, documentType: "QPC" });
  assert.equal(parsed.xmlMemberCount, 3);
  assert.equal(parsed.records.length, 1);
  assert.deepEqual(parsed.records[0], {
    dilaId: "CONSTEXT000000000001",
    nature: "QPC",
    qualifiedNature: "QPC",
    title: "Décision 2024-1115",
    decisionDate: "2024-12-13",
    decisionNumber: "2024-1115",
    ecli: "ECLI:FR:CC:2024:2024-1115.QPC",
    canonicalUrl: "https://www.conseil-constitutionnel.fr/decision/2024/20241115QPC.htm",
    conseilRecordId: "20241115QPC",
    archiveMemberPath: `${root}CONSTEXT000000000001.xml`,
  });
  assert.equal(parseDilaConstitArchive(archive, { year: 2024, documentType: "DC" }).records.length, 1);
});

test("DILA XML and tar parser reject entity declarations, traversal, links, and bad checksums", () => {
  const xml = dilaXml({ id: "CONSTEXT000000000004", nature: "QPC", date: "2024-01-01", number: "2024-1", record: "20241QPC" });
  assert.throws(
    () => parseDilaConstitXml(`<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]>${xml}`, "member.xml", { year: 2024, documentType: "QPC" }),
    /xml_entity_forbidden/,
  );
  assert.throws(
    () => parseDilaConstitArchive(dilaArchive([{ name: "../escape.xml", xml }]), { year: 2024, documentType: "QPC" }),
    /tar_path_invalid/,
  );
  assert.throws(
    () => parseDilaConstitArchive(dilaArchive([{ name: "constit/global/CONS/TEXT/link.xml", xml, type: "2" }]), { year: 2024, documentType: "QPC" }),
    /entry_type_forbidden/,
  );
  const expanded = zlib.gunzipSync(dilaArchive([{ name: "constit/global/CONS/TEXT/bad.xml", xml }]));
  const badChecksum = Buffer.from(expanded);
  badChecksum[10] ^= 1;
  assert.throws(
    () => parseDilaConstitArchive(zlib.gzipSync(badChecksum), { year: 2024, documentType: "QPC" }),
    /tar_checksum_invalid/,
  );
  const withoutTerminator = zlib.gzipSync(expanded.subarray(0, expanded.length - 1024));
  assert.throws(
    () => parseDilaConstitArchive(withoutTerminator, { year: 2024, documentType: "QPC" }),
    /tar_terminator_missing/,
  );
});

test("bounded governed fetch rejects declared and streamed overflow and releases permits", async () => {
  const server = createServer((request, response) => {
    response.statusCode = 200;
    if (request.url === "/declared") response.setHeader("content-length", "20");
    response.end("01234567890123456789");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const released: string[] = [];
  const governor = {
    async acquire(url: string) {
      return { async release() { released.push(url); } };
    },
  };
  try {
    await assert.rejects(
      governedBoundedFetch(`http://127.0.0.1:${address.port}/declared`, {}, 10, { requestGovernor: governor }),
      /response_too_large/,
    );
    await assert.rejects(
      governedBoundedFetch(`http://127.0.0.1:${address.port}/streamed`, {}, 10, { requestGovernor: governor }),
      /response_too_large/,
    );
    assert.equal(released.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("France governed fetch is Cheerio-only and declares both network phases", () => {
  const governor = { acquire: async () => ({ release: async () => undefined }) };
  assert.deepEqual(franceSpiderTransportOptions({
    strategy: "playwright",
    usePlaywright: true,
    requestGovernor: governor,
  }), {
    strategy: "cheerio",
    usePlaywright: false,
    requestGovernor: governor,
  });
  assert.deepEqual(
    loadCaseBackfillSourceStrategy("fr-conseil-constitutionnel").governedNetworkPhases,
    ["discover", "fetch"],
  );
});

test("Crawlee navigation permits cover retries, block redirects, and drain on teardown", async () => {
  const acquired: string[] = [];
  const released: string[] = [];
  const controller = createCrawlerNavigationPermitController({
    async acquire(url) {
      acquired.push(url);
      return { async release() { released.push(url); } };
    },
  });
  const first = {};
  const second = {};
  const navigationOptions = { followRedirect: true, maxRedirects: 10 };
  await controller.beforeNavigation(first, "https://www.conseil-constitutionnel.fr/decision/2024/a.htm", navigationOptions);
  assert.deepEqual(navigationOptions, { followRedirect: false, maxRedirects: 0 });
  await controller.release(first);
  await controller.beforeNavigation(first, "https://www.conseil-constitutionnel.fr/decision/2024/a.htm", navigationOptions);
  await assert.rejects(
    controller.afterNavigation(first, 302),
    /crawler\.request_governor_redirect_blocked/,
  );
  await controller.beforeNavigation(second, "https://www.conseil-constitutionnel.fr/decision/2024/b.htm");
  await controller.releaseAll();
  assert.deepEqual(acquired, [
    "https://www.conseil-constitutionnel.fr/decision/2024/a.htm",
    "https://www.conseil-constitutionnel.fr/decision/2024/a.htm",
    "https://www.conseil-constitutionnel.fr/decision/2024/b.htm",
  ]);
  assert.deepEqual(released, acquired);
});

test("governed Crawlee acquires separate permits for robots and the full response body", async () => {
  const previousRobotsSetting = process.env.CRAWLER_ROBOTS_ENABLED;
  process.env.CRAWLER_ROBOTS_ENABLED = "true";
  const server = createServer((request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/robots.txt") {
      response.end("User-agent: *\nAllow: /\n");
      return;
    }
    response.end(`<html><body><article>${"Décision constitutionnelle. ".repeat(80)}</article></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const detailUrl = `${baseUrl}/decision/2024/test.htm`;
  const acquired: string[] = [];
  const released: string[] = [];

  try {
    const result = await runOfficialSpider({
      sourceKey: `governed-france-test-${address.port}`,
      baseUrl,
      sitemapBaseUrls: [],
      listUrls: [],
      listSelectors: [],
      bodySelectors: ["article"],
      sitemapKeywords: [],
      seedItems: [],
      isCandidateUrl: () => true,
      itemFromUrl: (url) => ({
        sourceKey: "fr-conseil-constitutionnel",
        url,
        canonicalUrl: url,
        title: "Décision de test",
        contentType: "decision",
      }),
    }, {
      limit: 1,
      detailUrls: [detailUrl],
      detailOnly: true,
      strategy: "cheerio",
      usePlaywright: false,
      requestGovernor: {
        async acquire(url) {
          acquired.push(url);
          return { async release() { released.push(url); } };
        },
      },
    });
    assert.equal(result.items.length, 1);
    assert.ok(acquired.some((url) => url.endsWith("/robots.txt")));
    assert.ok(acquired.includes(detailUrl));
    assert.equal(released.length, acquired.length);
    assert.deepEqual([...released].sort(), [...acquired].sort());
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (previousRobotsSetting === undefined) delete process.env.CRAWLER_ROBOTS_ENABLED;
    else process.env.CRAWLER_ROBOTS_ENABLED = previousRobotsSetting;
  }
});

const franceSnapshot: CaseBackfillSnapshot = {
  id: "33333333-3333-4333-8333-333333333335",
  sourceKey: "fr-conseil-constitutionnel",
  scopeFrom: "2024-01-01",
  scopeTo: "2024-12-31",
  documentType: "QPC",
  parserVersion: "france-conseil-normalize-v1",
  sourcePolicyVersion: "france-conseil-2026-09-v1",
  status: "open",
};

const authority: CaseBackfillAttemptAuthority = {
  attemptId: "11111111-1111-4111-8111-111111111113",
  runId: "22222222-2222-4222-8222-222222222224",
  fencingToken: "19",
  leaseExpiresAt: "2026-09-03T12:00:00.000Z",
};

function discoveryPass(): CaseBackfillPassInput {
  return {
    cohort: "catalog-backfill",
    snapshotId: franceSnapshot.id,
    phase: "discover",
    passNumber: 1,
    batchLimit: 50,
  };
}

function discoveryRepository(overrides: Partial<CaseBackfillRepository>): CaseBackfillRepository {
  const unavailable = async () => { throw new Error("unused"); };
  return {
    openSnapshot: unavailable,
    upsertInventoryItem: unavailable,
    updateSnapshotEvidence: unavailable,
    closeSnapshot: unavailable,
    getSnapshot: async () => franceSnapshot,
    getSourcePolicy: async () => ({
      sourceKey: franceSnapshot.sourceKey,
      policyVersion: franceSnapshot.sourcePolicyVersion,
      normalizeReplayPolicy: "bounded_evidence",
      boundedReplayFields: ["sourceKey", "url", "canonicalUrl", "title", "contentType", "text"],
      minRequestDelayMs: 3000,
      maxConcurrency: 1,
      reviewDueAt: "2027-09-03T00:00:00.000Z",
    }),
    getSnapshotStatus: unavailable,
    acquireSourceRequestPermit: unavailable,
    releaseSourceRequestPermit: unavailable,
    allocatePass: unavailable,
    beginRun: unavailable,
    finishRun: unavailable,
    countBacklog: unavailable,
    claimItems: unavailable,
    extendItems: unavailable,
    recordFetchArtifact: unavailable,
    getFetchArtifact: unavailable,
    getNormalizationArtifact: unavailable,
    recordNormalizationArtifact: unavailable,
    publishItem: unavailable,
    completeItem: unavailable,
    failItem: unavailable,
    ...overrides,
  } as CaseBackfillRepository;
}

test("France discovery guard rejects execution before creating a run", async () => {
  let began = false;
  const repository = discoveryRepository({
    beginRun: async () => {
      began = true;
      return "55555555-5555-4555-8555-555555555557";
    },
  });
  await assert.rejects(
    runCaseBackfillPass(discoveryPass(), {
      authority, checkpoint: async () => undefined, signal: new AbortController().signal,
    }, {
      repository,
      loadAdapter: async () => null,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      environment: {},
    }),
    /case_backfill\.france_history_disabled/,
  );
  assert.equal(began, false);
});

test("France discovery fixes official count evidence before closing its manifest", async () => {
  const written: string[] = [];
  let evidenceCall: unknown[] = [];
  let closed = false;
  const repository = discoveryRepository({
    beginRun: async () => "55555555-5555-4555-8555-555555555557",
    upsertInventoryItem: async (input) => {
      written.push(input.stableItemKey);
      return "66666666-6666-4666-8666-666666666668";
    },
    updateSnapshotEvidence: async (...args) => { evidenceCall = args; },
    closeSnapshot: async () => {
      closed = true;
      return {
        snapshotId: franceSnapshot.id,
        sourceKey: franceSnapshot.sourceKey,
        snapshotStatus: "closed",
        discoveredTotal: 1,
        terminalTotal: 0,
        processingCompletion: 0,
        expectedCount: 1,
        coverageAssurance: "authoritative_counted",
        corpusCoverage: 1,
        claimed: 0,
        retryWait: 0,
        needsNormalize: 0,
        needsReverify: 0,
        needsRepublish: 0,
        failed: 0,
        currentConformant: 0,
        currentConformance: 0,
        manifestHash: "a".repeat(64),
      };
    },
    finishRun: async () => undefined,
  });
  const result = await runCaseBackfillPass(discoveryPass(), {
      authority, checkpoint: async () => undefined, signal: new AbortController().signal,
    }, {
      repository,
      loadAdapter: async () => null,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      environment: { [CASE_CATALOG_FRANCE_HISTORY_FLAG]: "true" },
      discoverFranceDilaConstitInventory: async (input) => {
        assert.deepEqual([input.year, input.documentType, input.currentYear], [2024, "QPC", 2026]);
        return {
          sourceKey: "fr-conseil-constitutionnel",
          year: 2024,
          documentType: "QPC",
          items: [{
            stableItemKey: "constit:constext000050783534",
            sourceRecordId: "20241115QPC",
            discoveredUrl: "https://www.conseil-constitutionnel.fr/decision/2024/20241115QPC.htm",
            documentType: "QPC",
            decisionDateHint: "2024-12-13",
            title: "Décision n° 2024-1115 QPC du 13 décembre 2024",
            dilaId: "CONSTEXT000050783534",
            ecli: "ECLI:FR:CC:2024:2024.1115.QPC",
            decisionNumber: "2024-1115",
            archiveMemberPath: "constit/global/CONS/TEXT/00/00/50/78/35/CONSTEXT000050783534.xml",
          }],
          pageCount: 1,
          expectedCount: 1,
          expectedCountBasis: "official_dila_stock_and_conseil_facet_exact_identity_set",
          coverageEvidence: { method: "official_dila_constit_stock_with_conseil_identity_crosscheck", expectedCount: 1 },
        };
      },
    });
  assert.deepEqual(written, ["constit:constext000050783534"]);
  assert.deepEqual(evidenceCall, [
    franceSnapshot.id,
    { method: "official_dila_constit_stock_with_conseil_identity_crosscheck", expectedCount: 1 },
    1,
    "official_dila_stock_and_conseil_facet_exact_identity_set",
  ]);
  assert.equal(closed, true);
  assert.equal(result.succeeded, 1);
});

test("France authority verification binds host, type, date, and official path identity", () => {
  const item = {
    itemId: "44444444-4444-4444-8444-444444444446",
    stableItemKey: "conseil:20241115qpc",
    sourceRecordId: "20241115QPC",
    discoveredUrl: "https://www.conseil-constitutionnel.fr/decision/2024/20241115QPC.htm",
    authorityUrl: null,
    documentType: "QPC",
    decisionDateHint: "2024-12-13",
    resolutionStatus: "normalized",
    currentFetchArtifactId: null,
    currentNormalizationArtifactId: null,
    verifiedNormalizationArtifactId: null,
    publishedNormalizationArtifactId: null,
    itemLeaseExpiresAt: "2026-09-03T12:00:00.000Z",
  };
  const valid = {
    sourceKey: franceSnapshot.sourceKey,
    jurisdiction: "France",
    institutionName: "Conseil constitutionnel",
    contentType: "decision" as const,
    originalUrl: item.discoveredUrl,
    canonicalUrl: item.discoveredUrl,
    originalLanguage: "fr",
    originalTitle: "Décision n° 2024-1115 QPC du 13 décembre 2024",
    originalPublishedAt: "2024-12-13T00:00:00.000Z",
    metadata: { caseNumber: "2024-1115 QPC" },
  };
  assert.deepEqual(validateNormalizedCase(valid, item, franceSnapshot), []);
  assert.deepEqual(validateNormalizedCase({
    ...valid,
    canonicalUrl: "https://qpc360.conseil-constitutionnel.fr/2024-12-13/decision-2024-1115-qpc",
    originalTitle: "Décision n° 2024-873 DC du 12 décembre 2024",
    originalPublishedAt: "2025-01-01T00:00:00.000Z",
  }, item, franceSnapshot), [
    "authority_url_invalid",
    "resolution_type_mismatch",
    "decision_date_after_scope",
    "source_record_id_mismatch",
  ]);
});
