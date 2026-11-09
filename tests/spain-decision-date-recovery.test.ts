import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSpainDateOnly,
  parseSpanishLongDateValue,
  validateSpainDecisionDate,
} from "../lib/ingest/spain-decision-date";
import {
  buildSpainDateRecoveryPlan,
  evidenceFromOfficialPayload,
  extractSpainHjId,
} from "../lib/ingest/spain-decision-date-recovery";
import {
  SPAIN_DATE_RECOVERY_CORE_SQL,
  SPAIN_DATE_RECOVERY_VERSION_SQL,
} from "../scripts/audit-spain-decision-dates";

test("Spain decision date parser validates all official HJ date shapes and rejects invalid dates", () => {
  assert.equal(normalizeSpainDateOnly("2026-10-05T00:00:00"), "2026-10-05");
  assert.equal(normalizeSpainDateOnly("2026-10-05T00:00:00.000Z"), "2026-10-05");
  assert.equal(normalizeSpainDateOnly("2026-10-05"), "2026-10-05");
  assert.equal(normalizeSpainDateOnly("19/10/2026 0:00:00"), "2026-10-19");
  assert.equal(normalizeSpainDateOnly("19/10/2026"), "2026-10-19");
  assert.equal(normalizeSpainDateOnly(" 2026-10-05T00:00:00 "), "2026-10-05");
  assert.equal(normalizeSpainDateOnly("31/02/2026 0:00:00"), undefined);
  assert.equal(normalizeSpainDateOnly("2026-13-01T00:00:00"), undefined);
  assert.equal(normalizeSpainDateOnly("not a date"), undefined);
  assert.equal(normalizeSpainDateOnly(null), undefined);
  assert.equal(parseSpanishLongDateValue("de 5 de octubre de 2026"), "2026-10-05");
  assert.equal(parseSpanishLongDateValue("8 de julio de 2026"), "2026-07-08");
  assert.equal(validateSpainDecisionDate({ FECHA_REGISTRO: "2026-10-05T00:00:00", FECHA_FIRMA: "de 5 de octubre de 2026" }).ok, true);
  const mismatch = validateSpainDecisionDate({ FECHA_REGISTRO: "2026-10-05T00:00:00", FECHA_FIRMA: "de 6 de octubre de 2026" });
  assert.equal(mismatch.ok, false);
  assert.match(String(mismatch.reason), /FECHA_FIRMA/);
});

test("HJ id extraction uses source metadata first and rejects non-official URLs", () => {
  assert.equal(extractSpainHjId({ source_metadata: JSON.stringify({ hjId: "32150" }), canonical_url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/99999" }), "32150");
  assert.equal(extractSpainHjId({ canonical_url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/32151?ACTION=detalle" }), "32151");
  assert.equal(extractSpainHjId({ canonical_url: "https://evil.example/HJ/es/Resolucion/Show/32151" }), undefined);
  assert.equal(extractSpainHjId({ canonical_url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/0" }), undefined);
  assert.equal(extractSpainHjId({ canonical_url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/not-a-number" }), undefined);
});

test("dry-run recovery plan produces guarded Core SQL and republish-required version actions", async () => {
  const payloads: Record<string, Record<string, unknown>> = {
    "32150": { TIPO_RESOLUCION: "SENTENCIA", ANNO_RESOLUCION: 2026, FECHA_REGISTRO: "2026-10-05T00:00:00", FECHA_FIRMA: "de 5 de octubre de 2026" },
    "32151": { TIPO_RESOLUCION: "SENTENCIA", ANNO_RESOLUCION: 2026, FECHA_REGISTRO: "2026-10-06T00:00:00" },
    "32152": { TIPO_RESOLUCION: "SENTENCIA", ANNO_RESOLUCION: 2026, FECHA_REGISTRO: "31/02/2026 0:00:00" },
    "32153": { TIPO_RESOLUCION: "SENTENCIA", ANNO_RESOLUCION: 2026 },
  };
  const fetched: string[] = [];
  const plan = await buildSpainDateRecoveryPlan({
    now: "2026-11-07T00:00:00.000Z",
    coreRows: [
      { id: "core-1", canonical_url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/32150", original_published_at: null, fetched_at: "2026-11-03T21:45:17.048Z", content_hash: "hash-1" },
      { id: "core-2", canonical_url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/32150", original_published_at: null, fetched_at: "2026-11-03T22:00:00.000Z", content_hash: "hash-2" },
      { id: "core-3", canonical_url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/32152", original_published_at: null },
      { id: "core-4", canonical_url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/32153", original_published_at: null },
      { id: "core-5", canonical_url: "https://example.invalid/unknown", original_published_at: null },
      { id: "core-6", canonical_url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/32154", original_published_at: null },
      { id: "core-7", canonical_url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/32151", original_published_at: "2026-10-06T00:00:00.000Z" },
    ],
    versionRows: [
      { article_id: "core-1", version_id: "version-1", canonical_url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/32150", version_original_published_at: null, version_revision: 4, publication_revision: 4, version_content_hash: "vhash", source_content_hash: "shash" },
    ],
    maxOfficialFetches: 10,
    fetchEvidence: async (hjId, canonicalUrl) => {
      fetched.push(hjId);
      const payload = payloads[hjId];
      if (!payload) return { hjId, canonicalUrl, fetched: false, ok: false, reason: "Official HJ JSON unavailable.", checks: [], warnings: [] };
      return evidenceFromOfficialPayload(hjId, canonicalUrl, payload);
    },
  });

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.writes, 0);
  assert.equal(plan.applySupported, false);
  assert.equal(plan.core.total, 7);
  assert.equal(plan.core.repairable, 2);
  assert.equal(plan.versions.total, 1);
  assert.equal(plan.versions.repairable, 1);
  assert.equal(plan.officialFetchCount, 4, "one official fetch per distinct HJ id, already-dated and unresolved rows excluded");

  const first = plan.core.rows[0];
  assert.equal(first.status, "repairable");
  assert.equal(first.proposedOriginalPublishedAt, "2026-10-05T00:00:00.000Z");
  assert.match(String(first.sqlPreview), /UPDATE articles SET original_published_at='2026-10-05T00:00:00.000Z'/);
  assert.match(String(first.sqlPreview), /original_published_at IS NULL/);
  assert.match(String(first.sqlPreview), /fetched_at IS '2026-11-03T21:45:17.048Z'/);
  assert.match(String(first.sqlPreview), /content_hash IS 'hash-1'/);
  assert.equal(plan.core.rows[1].status, "repairable");
  assert.equal(plan.core.rows[2].status, "source_date_invalid");
  assert.equal(plan.core.rows[3].status, "source_date_missing");
  assert.equal(plan.core.rows[4].status, "hj_id_missing");
  assert.equal(plan.core.rows[5].status, "official_fetch_failed");
  assert.equal(plan.core.rows[6].status, "already_dated");

  const version = plan.versions.rows[0];
  assert.equal(version.action, "republish_required");
  assert.equal(version.proposedOriginalPublishedAt, "2026-10-05T00:00:00.000Z");
  assert.deepEqual(version.guard, {
    versionOriginalPublishedAtIsNull: true,
    versionRevision: "4",
    publicationRevision: "4",
    versionContentHash: "vhash",
    sourceContentHash: "shash",
  });
  assert.deepEqual(fetched.sort(), ["32150", "32152", "32153", "32154"]);
});

test("recovery audit SQL is read-only, source-scoped and null-date scoped", () => {
  assert.match(SPAIN_DATE_RECOVERY_CORE_SQL, /^SELECT /);
  assert.match(SPAIN_DATE_RECOVERY_CORE_SQL, /source_key='es-tribunal-constitucional'/);
  assert.match(SPAIN_DATE_RECOVERY_CORE_SQL, /original_published_at IS NULL/);
  assert.match(SPAIN_DATE_RECOVERY_VERSION_SQL, /^SELECT /);
  assert.match(SPAIN_DATE_RECOVERY_VERSION_SQL, /p\.state='published'/);
  assert.match(SPAIN_DATE_RECOVERY_VERSION_SQL, /v\.original_published_at IS NULL/);
  assert.doesNotMatch(SPAIN_DATE_RECOVERY_CORE_SQL, /\b(?:UPDATE|INSERT|DELETE|DROP|ALTER)\b/i);
  assert.doesNotMatch(SPAIN_DATE_RECOVERY_VERSION_SQL, /\b(?:UPDATE|INSERT|DELETE|DROP|ALTER)\b/i);
});
