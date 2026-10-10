import assert from "node:assert/strict";
import test from "node:test";
import { assessP3RefreshCandidate, type P3RefreshCandidate } from "@/lib/admin/p4/p3-drift-refresh";
import { actionAllowedForKind, parseAdminWorkActionBody } from "@/lib/admin/p4/actions";

function candidate(): P3RefreshCandidate {
  return {
    id: "16b4fc11-d9cc-4e5b-b8e5-acf687ab760e", source_key: "fr-conseil-constitutionnel",
    updated_at: "2026-10-10T00:00:00Z", status: "summarized", original_language: "fr", translation_status: "translated",
    lifecycle_collection_state: "source_text_ready", lifecycle_processing_state: "complete",
    lifecycle_review_state: "unreviewed", lifecycle_attention_state: "clear",
    source_metadata: JSON.stringify({ collection: { publishable: true, sourceTextAvailable: true, sourceUrlVerified: true, strategy: "fetch" } }),
    canonical_url: "https://www.conseil-constitutionnel.fr/decision/2026/2026335L.htm",
    cleaned_text: "a".repeat(600), summary_json: '{"title":"new"}', korean_title: "새 요약",
    publication_state: "published", version_id: "00000000-0000-4000-8000-000000000001", publication_revision: 1,
    version_cleaned_text: "b".repeat(600), version_summary_json: '{"title":"old"}',
    version_korean_title: "구 요약", version_canonical_url: "https://www.conseil-constitutionnel.fr/decision/2026/2026335L.htm",
  };
}

test("bounded P3 repair only allows known source-verified drift", () => {
  assert.deepEqual(assessP3RefreshCandidate(candidate()), { eligible: true, changed: true });
  assert.deepEqual(assessP3RefreshCandidate({ ...candidate(), id: "11111111-1111-4111-8111-111111111111" }), { eligible: false, reason: "out_of_cohort" });
  assert.deepEqual(assessP3RefreshCandidate({ ...candidate(), canonical_url: "https://example.invalid/decision" }), { eligible: false, reason: "source_unverified" });
  assert.deepEqual(assessP3RefreshCandidate({ ...candidate(), canonical_url: "http://www.conseil-constitutionnel.fr/decision/2026/2026335L.htm" }), { eligible: false, reason: "source_unverified" });
  assert.deepEqual(assessP3RefreshCandidate({ ...candidate(), lifecycle_review_state: "needs_review" }), { eligible: false, reason: "review_blocked" });
  assert.deepEqual(assessP3RefreshCandidate({ ...candidate(), publication_state: "withdrawn" }), { eligible: false, reason: "not_published" });
});

test("stale legacy provenance is denied, even if current collection flags are true", () => {
  const row = { ...candidate(), id: "d31eecc5-4e74-440f-ba6e-1561911bd68c", source_key: "es-tribunal-constitucional", canonical_url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/32136" };
  assert.deepEqual(assessP3RefreshCandidate({ ...row, source_metadata: JSON.stringify({ collection: { publishable: true, sourceTextAvailable: true, sourceUrlVerified: true }, collectionSafety: { publishable: false } }) }), { eligible: false, reason: "provenance_conflict" });
});

test("no-op repeat cannot create publication revisions", () => {
  const row = candidate();
  assert.deepEqual(assessP3RefreshCandidate({ ...row, version_cleaned_text: row.cleaned_text, version_summary_json: row.summary_json, version_korean_title: row.korean_title }), { eligible: false, reason: "no_drift" });
});

test("P3 refresh requires a human admin confirmation and article kind", () => {
  assert.equal(actionAllowedForKind("article", "refresh-p3"), true);
  assert.equal(actionAllowedForKind("execution", "refresh-p3"), false);
  assert.equal(parseAdminWorkActionBody({ action: "refresh-p3", reason: "official source reviewed", confirmation: "wrong", idempotencyKey: "p3.refresh.12345" }).ok, false);
  assert.equal(parseAdminWorkActionBody({ action: "refresh-p3", reason: "official source reviewed", confirmation: "refresh-p3", idempotencyKey: "p3.refresh.12345" }).ok, true);
});
