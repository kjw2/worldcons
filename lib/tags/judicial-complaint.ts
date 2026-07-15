import type { SummaryJson } from "@/lib/db/types";
import { normalizeTagSlug } from "@/lib/utils/slug";

export const CONSTITUTIONAL_COMPLAINT_TAG_NAME = "헌법소원";
export const JUDICIAL_COMPLAINT_TAG_NAME = "재판소원";
export const JUDICIAL_COMPLAINT_TAG_SLUG = normalizeTagSlug(JUDICIAL_COMPLAINT_TAG_NAME);
export const JUDICIAL_COMPLAINT_TAG_DESCRIPTION =
  "법원의 판결이나 결정을 직접 대상으로 제기된 헌법소원";

export interface JudicialComplaintInput {
  sourceKey: string;
  canonicalUrl?: string | null;
  cleanedText?: string | null;
  sourceMetadata?: unknown;
}

export interface JudicialComplaintClassification {
  matched: boolean;
  reason: "de-bverfg-judicial-verfassungsbeschwerde" | "es-tc-judicial-amparo" | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedText(value: unknown, ...keys: string[]) {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return "";
    current = current[key];
  }
  return typeof current === "string" ? current.trim() : "";
}

function compactText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function isGermanJudicialComplaint(input: JudicialComplaintInput) {
  const prefix = compactText((input.cleanedText ?? "").slice(0, 16_000));
  const canonicalUrl = input.canonicalUrl ?? nestedText(input.sourceMetadata, "dedupKeys", "canonicalUrl");
  const hasBvrDocket = /\b\d\s*BvR\s*\d+/i.test(prefix) || /\d+bvr\d+/i.test(canonicalUrl);
  if (!hasBvrDocket) return false;

  const description = nestedText(input.sourceMetadata, "crawledMetadata", "description");
  const text = compactText(`${description}\n${prefix}`);
  if (!/Verfassungsbeschwerde/i.test(text)) return false;

  const judicialPatterns = [
    /Gegenstand der Verfassungsbeschwerde ist.{0,700}(?:gerichtlich|Beschluss|Urteil|Beschwerdeentscheidung|Durchsuchungsanordnung)/i,
    /Die Verfassungsbeschwerde betrifft.{0,500}(?:gerichtlich|Ausgangsverfahren|Beschluss|Urteil|Verurteilung)/i,
    /Verfassungsbeschwerde.{0,500}gegen.{0,1600}(?:Beschluss|Urteil|Terminsladung|gerichtliche Entscheidung|Beschwerdeentscheidung).{0,600}(?:Amtsgericht|Landgericht|Oberlandesgericht|Bundesgerichtshof|Verwaltungsgericht|Oberverwaltungsgericht|Bundesverwaltungsgericht|Sozialgericht|Landessozialgericht|Bundessozialgericht|Arbeitsgericht|Landesarbeitsgericht|Bundesarbeitsgericht|Finanzgericht|Bundesfinanzhof|Verfassungsgerichtshof|Staatsgerichtshof|Gericht|gericht|Senat|Kammer)/i,
    /(?:angegriffen|angegriffenen|zugrundeliegend|fachgerichtlich).{0,250}(?:Beschluss|Urteil|Entscheidung).{0,250}(?:Gericht|gericht|Senat|Kammer)/i,
  ];

  return judicialPatterns.some((pattern) => pattern.test(text));
}

export function extractSpanishAmparoHeader(cleanedText?: string | null) {
  const prefix = compactText((cleanedText ?? "").slice(0, 16_000));
  const start = prefix.search(/En (?:el|los) recurso(?:s)? de amparo/i);
  if (start < 0) return "";

  const tail = prefix.slice(start);
  const end = tail.search(
    /(?:Se ha personado|Han comparecido|Ha comparecido|Ha intervenido|Han intervenido|Ha sido ponente|Antecedentes)/i,
  );
  return tail.slice(0, end > 0 ? end : Math.min(tail.length, 7_000));
}

function isSpanishJudicialComplaint(input: JudicialComplaintInput) {
  const header = extractSpanishAmparoHeader(input.cleanedText);
  if (!header) return false;

  const judicialTarget =
    /(?:\bcontra\b|\brespecto de\b|\bfrente (?:a|al|a la|a los|a las)\b|\ben relación con\b).{0,6000}(?:\bsentencias?\b|\bautos?\b|\bprovidencias?\b|resoluciones? judiciales?|juzgad[oa]|audiencia provincial|tribunal supremo|tribunal superior de justicia|sala de lo (?:civil|penal|social|contencioso)|órgano judicial)/i;
  const judicialProceeding =
    /\ben (?:pleito|proceso|procedimiento) (?:social|penal|civil|contencioso(?:-administrativo)?)\b|\ben causa penal\b/i;

  return judicialTarget.test(header) || judicialProceeding.test(header);
}

export function classifyJudicialComplaint(input: JudicialComplaintInput): JudicialComplaintClassification {
  if (input.sourceKey === "de-bverfg" && isGermanJudicialComplaint(input)) {
    return { matched: true, reason: "de-bverfg-judicial-verfassungsbeschwerde" };
  }
  if (input.sourceKey === "es-tribunal-constitucional" && isSpanishJudicialComplaint(input)) {
    return { matched: true, reason: "es-tc-judicial-amparo" };
  }
  return { matched: false, reason: null };
}

function appendUniqueTag(tags: string[], tag: string) {
  const normalized = tag.trim().toLocaleLowerCase("ko-KR");
  return tags.some((item) => item.trim().toLocaleLowerCase("ko-KR") === normalized) ? tags : [...tags, tag];
}

export function ensureJudicialComplaintTags(summary: SummaryJson, input: JudicialComplaintInput): SummaryJson {
  if (!classifyJudicialComplaint(input).matched) return summary;

  const withParent = appendUniqueTag(summary.tags, CONSTITUTIONAL_COMPLAINT_TAG_NAME);
  const tags = appendUniqueTag(withParent, JUDICIAL_COMPLAINT_TAG_NAME);
  return tags === summary.tags ? summary : { ...summary, tags };
}
