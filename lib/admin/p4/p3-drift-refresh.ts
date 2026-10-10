/** Explicitly bounded P3 snapshot refresh cohort, never a global re-publisher. */
export const P3_DRIFT_REFRESH_CANARY_IDS = new Set([
  "0e25c3b4-3449-46b5-9270-fd0e37f9e4b7", // FR 2026-1223 QPC
  "16b4fc11-d9cc-4e5b-b8e5-acf687ab760e", // FR 2026-335 L
  "15560a96-c510-427c-aaf4-a5d57ef5bd50", // ES AUTO 43/2026
  "d31eecc5-4e74-440f-ba6e-1561911bd68c", // ES SENTENCIA 59/2026
]);

export const SPAIN_SENTENCIA_59_ID = "d31eecc5-4e74-440f-ba6e-1561911bd68c";
export const SPAIN_SENTENCIA_59_OFFICIAL_API = "https://hj.tribunalconstitucional.es/HJ/Resolucion/Api/json/32136";

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

/** A conflicting 2026/59 metadata-only flag may only be superseded by fresh
 * evidence from the exact official HJ JSON record and matching current Core text.
 * The caller must persist this with an optimistic revision guard, then re-read
 * the candidate before performing the normal P3 transition. */
export function revalidatedSentencia59Metadata(
  row: P3RefreshCandidate,
  official: unknown,
  checkedAt: string,
): string {
  if (row.id !== SPAIN_SENTENCIA_59_ID
    || row.source_key !== "es-tribunal-constitucional"
    || row.canonical_url !== "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/32136"
    || row.cleaned_text.length < 60_000) throw new Error("p3_revalidate.wrong_article_or_text");
  if (!official || typeof official !== "object" || Array.isArray(official)) {
    throw new Error("p3_revalidate.official_payload_invalid");
  }
  const payload = official as Record<string, unknown>;
  if (payload.TIPO_RESOLUCION !== "SENTENCIA"
    || Number(payload.NUMERO_RESOLUCION) !== 59
    || Number(payload.ANNO_RESOLUCION) !== 2026
    || payload.CONTENIDO_IRRELEVANTE_PARA_INTERNET !== false
    || (typeof payload.AVISO === "string" && /no incorpora doctrina|no contiene doctrina/i.test(payload.AVISO))) {
    throw new Error("p3_revalidate.official_identity_or_safety_invalid");
  }
  const sectionNames = [
    "RESOLUCIONES_ANTECEDENTES", "RESOLUCIONES_FUNDAMENTOS",
    "RESOLUCIONES_DICTAMEN", "RESOLUCIONES_VOTOS_PARTICULARES",
  ];
  const sections = sectionNames.flatMap((key) => {
    const entries = payload[key];
    return Array.isArray(entries) ? entries.map((entry: unknown) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as { TEXTO?: unknown }).TEXTO : null).filter((text): text is string => typeof text === "string") : [];
  });
  const normalize = (value: string) => value
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const core = normalize(row.cleaned_text);
  const substantives = sections.map(normalize).filter((text) => text.length > 180);
  const matches = substantives.filter((text) => core.includes(text.slice(0, 95))).length;
  if (sections.length < 12 || substantives.join("").length < 50_000 || matches < 4) {
    throw new Error("p3_revalidate.official_full_text_does_not_match_core");
  }
  const metadata = JSON.parse(row.source_metadata) as Record<string, unknown>;
  const collection = metadata.collection as Record<string, unknown> | undefined;
  if (!collection || collection.sourceUrlVerified !== true || collection.sourceTextAvailable !== true
    || collection.publishable !== true) throw new Error("p3_revalidate.collection_not_verified");
  const { cleanedTextSha256: _oldCleanedHash, rawTextSha256: _oldRawHash, ...rest } = metadata;
  const { reason: _oldReason, ...safeCollection } = collection;
  void _oldCleanedHash; void _oldRawHash; void _oldReason;
  return JSON.stringify({
    ...rest,
    collection: { ...safeCollection, reason: "Verified official HJ JSON full text, confirmed against current Core." },
    collectionSafety: { ...((metadata.collectionSafety && typeof metadata.collectionSafety === "object"
      && !Array.isArray(metadata.collectionSafety)) ? metadata.collectionSafety as Record<string, unknown> : {}),
      contenidoIrrelevanteParaInternet: false, publishable: true },
    sourceTextStatus: "available",
    sourceTextAvailable: true,
    sourceTextQuality: { cleanedTextLength: row.cleaned_text.length, hasSubstantiveSection: true,
      minLength: 2000, substantiveSections: sectionNames },
    sourceRevalidation: {
      verifiedAt: checkedAt, source: SPAIN_SENTENCIA_59_OFFICIAL_API,
      previousCollectionSafety: metadata.collectionSafety ?? null,
      previousSourceTextStatus: metadata.sourceTextStatus ?? null,
      officialSectionCount: sections.length, matchingSections: matches,
    },
  });
}
