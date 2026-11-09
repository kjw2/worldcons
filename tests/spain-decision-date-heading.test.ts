import assert from "node:assert/strict";
import test from "node:test";
import { buildSpainTcRawArticleFromJson } from "../lib/crawlee/spain-tribunal-constitucional-spider";
import {
  validateSpainDecisionDate,
  validateSpainOfficialDecisionDate,
} from "../lib/ingest/spain-decision-date";
import {
  evidenceFromOfficialDetail,
  evidenceFromOfficialPayload,
} from "../lib/ingest/spain-decision-date-recovery";
import {
  spainDateCorrectionEvidenceSha256,
} from "../lib/ingest/spain-decision-date-correction";
import {
  crawlNativeStageCandidate,
  type NativeCrawlerBindings,
  type NativeStageCandidate,
} from "../workers/async-pipeline/src/native-crawler";

const robots = "User-agent: *\nAllow: /\nCrawl-delay: 0";

interface HeadingFixture {
  hjId: string;
  heading: string;
  ecli: string;
  date: string;
  type: "SENTENCIA" | "AUTO";
  number: number;
  year: number;
  boe?: { number: string; date: string };
}

export const CONFIRMED_HEADINGS: HeadingFixture[] = [
  { hjId: "32151", heading: "SENTENCIA 67/2026, de 6 de octubre", ecli: "ECLI:ES:TC:2026:67", date: "2026-10-06", type: "SENTENCIA", number: 67, year: 2026 },
  { hjId: "32143", heading: "SENTENCIA 66/2026, de 5 de octubre", ecli: "ECLI:ES:TC:2026:66", date: "2026-10-05", type: "SENTENCIA", number: 66, year: 2026 },
  { hjId: "32150", heading: "SENTENCIA 65/2026, de 5 de octubre", ecli: "ECLI:ES:TC:2026:65", date: "2026-10-05", type: "SENTENCIA", number: 65, year: 2026 },
  {
    hjId: "32142", heading: "SENTENCIA 64/2026, de 23 de septiembre", ecli: "ECLI:ES:TC:2026:64",
    date: "2026-09-23", type: "SENTENCIA", number: 64, year: 2026,
    boe: { number: "269", date: "2026-10-29" },
  },
  { hjId: "32149", heading: "AUTO 56/2026, de 23 de septiembre", ecli: "ECLI:ES:TC:2026:56A", date: "2026-09-23", type: "AUTO", number: 56, year: 2026 },
  {
    hjId: "32136", heading: "SENTENCIA 59/2026, de 8 de septiembre", ecli: "ECLI:ES:TC:2026:59",
    date: "2026-09-08", type: "SENTENCIA", number: 59, year: 2026,
    boe: { number: "253", date: "2026-10-12" },
  },
];

function detailHtml(fixture: Pick<HeadingFixture, "heading" | "ecli" | "boe">) {
  const boeSpan = fixture.boe
    ? ` <span style="display: block; font-style: italic;"> (BOE num. ${fixture.boe.number}, de ${longDate(fixture.boe.date)}) </span>`
    : "";
  return `<!DOCTYPE html><html><head><title>Sistema HJ</title></head><body>
    <ul class="resolucion-identifiers">
      <li id="resolucion-identifier"><h2> ${fixture.heading}${boeSpan} </h2></li>
      <li id="resolucionECLI-identifier"><p><label class="ecli">${fixture.ecli}</label></p></li>
    </ul>
    <div id="complete_resolucion">... body text must never determine the date ...</div>
  </body></html>`;
}

function longDate(date: string) {
  const months = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const [year, month, day] = date.split("-");
  return `${Number(day)} de ${months[Number(month) - 1]} de ${year}`;
}

function payloadFor(fixture: HeadingFixture, overrides: Record<string, unknown> = {}) {
  return {
    TIPO_RESOLUCION: fixture.type,
    NUMERO_RESOLUCION: fixture.number,
    ANNO_RESOLUCION: fixture.year,
    ECLI: fixture.ecli,
    FECHA_REGISTRO: `${fixture.date}T00:00:00`,
    FECHA_FIRMA: longDate(fixture.date),
    ...(fixture.boe ? { FECHA_BOE: `${fixture.boe.date}T00:00:00` } : {}),
    ...overrides,
  };
}

test("six confirmed LIVE HJ detail headings parse the exact official decision dates", () => {
  for (const fixture of CONFIRMED_HEADINGS) {
    const validation = validateSpainOfficialDecisionDate({
      headingHtml: detailHtml(fixture),
      payload: payloadFor(fixture),
    });
    assert.equal(validation.ok, true, fixture.hjId);
    assert.equal(validation.decisionDate, fixture.date, fixture.hjId);
    assert.equal(validation.dateBasis, "detail_heading", fixture.hjId);
    assert.equal(validation.heading?.resolutionType, fixture.type, fixture.hjId);
    assert.equal(validation.heading?.resolutionNumber, fixture.number, fixture.hjId);
    assert.equal(validation.heading?.resolutionYear, fixture.year, fixture.hjId);
    assert.equal(validation.heading?.ecli, fixture.ecli, fixture.hjId);
    assert.equal(validation.ecli, fixture.ecli, fixture.hjId);
    if (fixture.boe) {
      assert.equal(validation.heading?.boeNumber, fixture.boe.number, fixture.hjId);
      assert.equal(validation.boeDate, fixture.boe.date, `${fixture.hjId} BOE date is distinct from decision date`);
      assert.notEqual(validation.decisionDate, validation.boeDate, fixture.hjId);
    } else {
      assert.equal(validation.boeDate, undefined, fixture.hjId);
    }
    assert.ok(validation.checks.some((check) => check.source === "detail_heading" && check.value === fixture.date));
    assert.ok(validation.checks.some((check) => check.source === "ECLI" && check.matches));
  }
});

test("a reversed listing date can never override the authoritative detail heading", () => {
  const fixture = CONFIRMED_HEADINGS[0];
  const raw = buildSpainTcRawArticleFromJson({
    ID: Number(fixture.hjId),
    TIPO_RESOLUCION: fixture.type,
    NUMERO_RESOLUCION: fixture.number,
    ANNO_RESOLUCION: fixture.year,
  }, {
    detailHeadingHtml: detailHtml(fixture),
    // The list/title says day 10 of June, the heading says 6 October.
    htmlTitle: "SENTENCIA 67/2026, de 10 de junio de 2026",
    fetchMethod: "json_api",
  });
  assert.equal(raw.publishedAt, "2026-10-06T00:00:00.000Z");
  assert.equal(raw.metadata?.decisionDate, "2026-10-06");
  assert.equal(raw.metadata?.dateBasis, "detail_heading");
  assert.notEqual(raw.metadata?.decisionDate, "2026-06-10");
});

test("missing or invalid JSON FECHA_REGISTRO is recovered from the detail heading, never guessed", () => {
  const fixture = CONFIRMED_HEADINGS[0];
  const missing = validateSpainOfficialDecisionDate({
    headingHtml: detailHtml(fixture),
    payload: {
      TIPO_RESOLUCION: fixture.type,
      NUMERO_RESOLUCION: fixture.number,
      ANNO_RESOLUCION: fixture.year,
      ECLI: fixture.ecli,
    },
  });
  assert.equal(missing.ok, true);
  assert.equal(missing.decisionDate, fixture.date);
  assert.equal(missing.dateBasis, "detail_heading");
  assert.ok(missing.warnings.some((warning) => /FECHA_REGISTRO is missing/u.test(warning)));
  assert.ok(missing.checks.some((check) => check.source === "FECHA_REGISTRO" && check.matches === false));

  const invalid = validateSpainOfficialDecisionDate({
    headingHtml: detailHtml(fixture),
    payload: payloadFor(fixture, { FECHA_REGISTRO: "31/02/2026 0:00:00" }),
  });
  assert.equal(invalid.ok, true);
  assert.equal(invalid.decisionDate, fixture.date);
  assert.ok(invalid.warnings.some((warning) => /FECHA_REGISTRO is invalid/u.test(warning)));

  const headingOnly = validateSpainOfficialDecisionDate({ headingHtml: detailHtml(fixture) });
  assert.equal(headingOnly.ok, true);
  assert.equal(headingOnly.decisionDate, fixture.date);
});

test("conflicting official evidence fails closed instead of inventing a date", () => {
  const fixture = CONFIRMED_HEADINGS[0];
  const registroConflict = validateSpainOfficialDecisionDate({
    headingHtml: detailHtml(fixture),
    payload: payloadFor(fixture, { FECHA_REGISTRO: "2026-06-10T00:00:00" }),
  });
  assert.equal(registroConflict.ok, false);
  assert.match(String(registroConflict.reason), /conflicts with HJ FECHA_REGISTRO/u);

  const firmaConflict = validateSpainOfficialDecisionDate({
    headingHtml: detailHtml(fixture),
    payload: payloadFor(fixture, { FECHA_FIRMA: "de 10 de junio de 2026" }),
  });
  assert.equal(firmaConflict.ok, false);
  assert.match(String(firmaConflict.reason), /FECHA_FIRMA/u);

  const boeConflict = validateSpainOfficialDecisionDate({
    headingHtml: detailHtml(fixture),
    payload: payloadFor(fixture, { FECHA_BOE: "2026-09-01T00:00:00" }),
  });
  assert.equal(boeConflict.ok, false);
  assert.match(String(boeConflict.reason), /BOE date/u);

  const boeCrossConflict = validateSpainOfficialDecisionDate({
    headingHtml: detailHtml(CONFIRMED_HEADINGS[3]),
    payload: payloadFor(CONFIRMED_HEADINGS[3], { FECHA_BOE: "2026-11-30T00:00:00" }),
  });
  assert.equal(boeCrossConflict.ok, false);
  assert.match(String(boeCrossConflict.reason), /BOE date/u);

  const ecliConflict = validateSpainOfficialDecisionDate({
    headingHtml: detailHtml(fixture),
    payload: payloadFor(fixture, { ECLI: "ECLI:ES:TC:2025:67" }),
  });
  assert.equal(ecliConflict.ok, false);
  assert.match(String(ecliConflict.reason), /ECLI/u);

  const jsonInternalConflict = validateSpainDecisionDate({ FECHA_REGISTRO: "2026-10-06", FECHA_FIRMA: "de 5 de octubre de 2026" });
  assert.equal(jsonInternalConflict.ok, false);
});

test("a misidentified heading (type/number/year) is rejected", () => {
  const fixture = CONFIRMED_HEADINGS[0];
  const wrongType = validateSpainOfficialDecisionDate({
    headingHtml: detailHtml(fixture),
    payload: payloadFor(fixture, { TIPO_RESOLUCION: "AUTO" }),
  });
  assert.equal(wrongType.ok, false);
  assert.match(String(wrongType.reason), /resolution type/u);

  const wrongNumber = validateSpainOfficialDecisionDate({
    headingHtml: detailHtml(fixture),
    payload: payloadFor(fixture, { NUMERO_RESOLUCION: 65 }),
  });
  assert.equal(wrongNumber.ok, false);
  assert.match(String(wrongNumber.reason), /case number/u);

  const wrongYear = validateSpainOfficialDecisionDate({
    headingHtml: detailHtml(fixture),
    payload: payloadFor(fixture, { ANNO_RESOLUCION: 2025 }),
  });
  assert.equal(wrongYear.ok, false);
  assert.match(String(wrongYear.reason), /year/u);

  const expectedIdentity = validateSpainOfficialDecisionDate({
    headingHtml: detailHtml(CONFIRMED_HEADINGS[4]),
    payload: payloadFor(fixture),
    expected: { resolutionType: "SENTENCIA", resolutionNumber: 67, resolutionYear: 2026 },
  });
  assert.equal(expectedIdentity.ok, false);
});

test("legacy JSON-only validation still distinguishes missing from invalid for recovery status", () => {
  const missing = validateSpainDecisionDate({ TIPO_RESOLUCION: "SENTENCIA" });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "FECHA_REGISTRO is missing.");
  const invalid = validateSpainDecisionDate({ FECHA_REGISTRO: "31/02/2026 0:00:00" });
  assert.equal(invalid.ok, false);
  assert.notEqual(invalid.reason, "FECHA_REGISTRO is missing.");
});

test("the correction evidence SHA256 binds the exact heading, ECLI and BOE evidence", async () => {
  const fixture = CONFIRMED_HEADINGS[3];
  const evidence = evidenceFromOfficialDetail({
    hjId: fixture.hjId,
    canonicalUrl: `https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/${fixture.hjId}`,
    html: detailHtml(fixture),
    payload: payloadFor(fixture),
  });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.decisionDate, fixture.date);
  assert.equal(evidence.evidenceBasis, "detail_heading");
  assert.equal(evidence.heading?.identifierText, fixture.heading);
  const hash = await spainDateCorrectionEvidenceSha256(evidence);
  assert.match(hash, /^[0-9a-f]{64}$/u);
  assert.equal(await spainDateCorrectionEvidenceSha256(evidence), hash, "evidence hash is deterministic");

  const jsonOnly = evidenceFromOfficialPayload(fixture.hjId, evidence.canonicalUrl, payloadFor(fixture));
  assert.notEqual(await spainDateCorrectionEvidenceSha256(jsonOnly), hash, "heading evidence is distinct from JSON-only evidence");

  const differentBoe = evidenceFromOfficialDetail({
    hjId: fixture.hjId,
    canonicalUrl: evidence.canonicalUrl,
    html: detailHtml({ ...fixture, boe: { number: "269", date: "2026-10-30" } }),
    payload: payloadFor(fixture),
  });
  assert.notEqual(await spainDateCorrectionEvidenceSha256(differentBoe), hash, "BOE evidence is part of the hash");
});

function response(body: string, status = 200, contentType = "text/html") {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

function installSpanishFetcher(options: {
  json?: Record<string, unknown> | null;
  html?: string | null;
  seen?: string[];
}) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    options.seen?.push(url);
    if (url.endsWith("/robots.txt")) return response(robots, 200, "text/plain");
    if (/\/(?:HJ\/)?Resolucion\/Api\/json\/\d+$/.test(url)) {
      if (options.json === null || options.json === undefined) return response("not found", 404);
      return response(JSON.stringify(options.json), 200, "application/json");
    }
    if (/\/Resolucion\/Show\/\d+$/.test(url)) {
      if (options.html === null || options.html === undefined) return response("not found", 404);
      return response(options.html);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

function stageCandidate(hjId: string): NativeStageCandidate {
  return {
    sourceKey: "es-tribunal-constitucional",
    url: `https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/${hjId}`,
    title: `SENTENCIA ${hjId}`,
    contentType: "decision",
    metadata: {
      hjId,
      collection: {
        strategy: "api",
        confidence: "high",
        sourceUrlVerified: true,
        sourceTextAvailable: false,
        strictSourceTextAvailable: true,
        publishable: false,
      },
    },
  };
}

function fullTextPayload(overrides: Record<string, unknown> = {}) {
  return {
    RESOLUCIONES_FUNDAMENTOS: [{ TEXTO: "Official court judgment text. ".repeat(120) }],
    ...overrides,
  };
}

test("safe new ingestion recovers a missing JSON date from the detail heading", async () => {
  const fixture = CONFIRMED_HEADINGS[0];
  const seen: string[] = [];
  const result = await crawlNativeStageCandidate(stageCandidate(fixture.hjId), {} as NativeCrawlerBindings, {
    fetch: installSpanishFetcher({
      json: fullTextPayload({
        TIPO_RESOLUCION: fixture.type,
        NUMERO_RESOLUCION: fixture.number,
        ANNO_RESOLUCION: fixture.year,
        ECLI: fixture.ecli,
      }),
      html: detailHtml(fixture),
      seen,
    }),
  });
  assert.equal(result.fetched, true);
  assert.equal(result.candidate.publishedAt, "2026-10-06T00:00:00.000Z");
  assert.equal(result.candidate.metadata.decisionDate, "2026-10-06");
  assert.equal(result.candidate.metadata.officialDecisionDate, "2026-10-06");
  assert.equal(result.candidate.metadata.dateBasis, "detail_heading");
  assert.equal((result.candidate.metadata.dateValidation as Record<string, unknown>).ok, true);
  assert.equal((result.candidate.metadata.collection as Record<string, unknown>).publishable, true);
  assert.ok(seen.some((url) => /\/Resolucion\/Show\/32151$/u.test(url)), "detail heading must be fetched");
});

test("safe new ingestion with a valid JSON date does not need the detail heading", async () => {
  const fixture = CONFIRMED_HEADINGS[0];
  const seen: string[] = [];
  const result = await crawlNativeStageCandidate(stageCandidate(fixture.hjId), {} as NativeCrawlerBindings, {
    fetch: installSpanishFetcher({
      json: fullTextPayload(payloadFor(fixture)),
      html: detailHtml(fixture),
      seen,
    }),
  });
  assert.equal(result.candidate.publishedAt, "2026-10-06T00:00:00.000Z");
  assert.equal(result.candidate.metadata.dateBasis, "FECHA_REGISTRO");
  assert.ok(!seen.some((url) => /\/Resolucion\/Show\/32151$/u.test(url)), "valid JSON dates stay on the cheap path");
});

test("safe new ingestion fails closed when JSON and detail heading conflict", async () => {
  const fixture = CONFIRMED_HEADINGS[0];
  const result = await crawlNativeStageCandidate(stageCandidate(fixture.hjId), {} as NativeCrawlerBindings, {
    fetch: installSpanishFetcher({
      json: fullTextPayload(payloadFor(fixture, { FECHA_REGISTRO: "2026-06-10T00:00:00" })),
      html: detailHtml(fixture),
    }),
  });
  assert.equal(result.fetched, true);
  assert.equal(result.candidate.publishedAt, undefined);
  assert.equal(result.candidate.metadata.decisionDate, undefined);
  assert.equal((result.candidate.metadata.dateValidation as Record<string, unknown>).ok, false);
  assert.equal((result.candidate.metadata.review as Record<string, unknown>).reason, "date_validation_failed");
  assert.equal((result.candidate.metadata.collection as Record<string, unknown>).publishable, false);
});

test("safe new ingestion rejects a misidentified heading even when JSON text exists", async () => {
  const fixture = CONFIRMED_HEADINGS[0];
  const result = await crawlNativeStageCandidate(stageCandidate(fixture.hjId), {} as NativeCrawlerBindings, {
    fetch: installSpanishFetcher({
      json: fullTextPayload({
        TIPO_RESOLUCION: "SENTENCIA",
        NUMERO_RESOLUCION: 65,
        ANNO_RESOLUCION: 2026,
      }),
      html: detailHtml(CONFIRMED_HEADINGS[4]),
    }),
  });
  assert.equal(result.candidate.publishedAt, undefined);
  assert.equal((result.candidate.metadata.dateValidation as Record<string, unknown>).ok, false);
  assert.equal((result.candidate.metadata.review as Record<string, unknown>).reason, "date_validation_failed");
});

test("fallback ingestion still recovers the official date when JSON is unavailable", async () => {
  const fixture = CONFIRMED_HEADINGS[0];
  const result = await crawlNativeStageCandidate(stageCandidate(fixture.hjId), {} as NativeCrawlerBindings, {
    fetch: installSpanishFetcher({ json: null, html: detailHtml(fixture) }),
  });
  assert.equal(result.fetched, false);
  assert.equal(result.candidate.publishedAt, "2026-10-06T00:00:00.000Z");
  assert.equal(result.candidate.metadata.dateBasis, "detail_heading");
  assert.equal((result.candidate.metadata.dateValidation as Record<string, unknown>).ok, true);
  assert.equal((result.candidate.metadata.review as Record<string, unknown>).reason, "official_json_unavailable");
  assert.equal((result.candidate.metadata.collection as Record<string, unknown>).publishable, false);
});
