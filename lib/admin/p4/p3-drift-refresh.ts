/** Explicitly bounded P3 snapshot refresh cohort, never a global re-publisher. */
export const P3_DRIFT_REFRESH_CANARY_IDS = new Set([
  "0e25c3b4-3449-46b5-9270-fd0e37f9e4b7", // FR 2026-1223 QPC
  "16b4fc11-d9cc-4e5b-b8e5-acf687ab760e", // FR 2026-335 L
  "15560a96-c510-427c-aaf4-a5d57ef5bd50", // ES AUTO 43/2026
  "d31eecc5-4e74-440f-ba6e-1561911bd68c", // ES SENTENCIA 59/2026
]);

export interface P3RefreshCandidate {
  id: string;
  source_key: string;
  updated_at: string;
  status: string;
  original_language: string;
  translation_status: string;
  lifecycle_collection_state: string;
  lifecycle_processing_state: string;
  lifecycle_review_state: string;
  lifecycle_attention_state: string;
  source_metadata: string;
  canonical_url: string;
  cleaned_text: string;
  summary_json: string;
  korean_title: string;
  publication_state: string;
  version_id: string;
  publication_revision: number | string;
  version_cleaned_text: string;
  version_summary_json: string;
  version_korean_title: string;
  version_canonical_url: string;
}

export type P3RefreshDecision =
  | { eligible: true; changed: true }
  | { eligible: false; reason: "out_of_cohort" | "not_published" | "source_unverified" | "review_blocked" | "no_drift" | "provenance_conflict" };

export function assessP3RefreshCandidate(row: P3RefreshCandidate): P3RefreshDecision {
  if (!P3_DRIFT_REFRESH_CANARY_IDS.has(row.id)) return { eligible: false, reason: "out_of_cohort" };
  if (row.publication_state !== "published" || !row.version_id) return { eligible: false, reason: "not_published" };
  if (row.status !== "summarized"
    || (row.translation_status !== "translated" && !(row.original_language?.toLowerCase() === "ko" && row.translation_status === "not_required"))
    || row.lifecycle_collection_state !== "source_text_ready"
    || row.lifecycle_processing_state !== "complete"
    || row.lifecycle_attention_state !== "clear"
    || !["approved", "unreviewed"].includes(row.lifecycle_review_state)) {
    return { eligible: false, reason: "review_blocked" };
  }
  let metadata: Record<string, unknown>;
  try { metadata = JSON.parse(row.source_metadata) as Record<string, unknown>; }
  catch { return { eligible: false, reason: "source_unverified" }; }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return { eligible: false, reason: "source_unverified" };
  const collection = metadata.collection as Record<string, unknown> | undefined;
  const catalog = metadata.catalog as Record<string, unknown> | undefined;
  const safety = metadata.collectionSafety as Record<string, unknown> | undefined;
  if (safety?.publishable === false || metadata.sourceTextStatus === "not_available") {
    return { eligible: false, reason: "provenance_conflict" };
  }
  if (collection?.publishable !== true || collection?.sourceTextAvailable !== true
    || collection?.sourceUrlVerified !== true || collection?.robotsDisallowed === true
    || collection?.strategy === "seed" || catalog?.sourceOnly === true) {
    return { eligible: false, reason: "source_unverified" };
  }
  let hostname: string;
  try {
    const url = new URL(row.canonical_url);
    if (url.protocol !== "https:") return { eligible: false, reason: "source_unverified" };
    hostname = url.hostname.toLowerCase();
  }
  catch { return { eligible: false, reason: "source_unverified" }; }
  if (!(row.source_key === "fr-conseil-constitutionnel" && hostname === "www.conseil-constitutionnel.fr")
    && !(row.source_key === "es-tribunal-constitucional" && hostname === "hj.tribunalconstitucional.es")) {
    return { eligible: false, reason: "source_unverified" };
  }
  if (row.cleaned_text?.trim().length < 500 || !row.summary_json || !row.korean_title?.trim()) {
    return { eligible: false, reason: "source_unverified" };
  }
  if (row.cleaned_text === row.version_cleaned_text && row.summary_json === row.version_summary_json
    && row.korean_title === row.version_korean_title && row.canonical_url === row.version_canonical_url) {
    return { eligible: false, reason: "no_drift" };
  }
  return { eligible: true, changed: true };
}
