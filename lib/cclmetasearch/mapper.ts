import type { CclMetasearchItem } from "@/lib/cclmetasearch/contract";
import { jurisdictionCodeFor } from "@/lib/portal/worldlaws";
import { displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";
import { safeExternalUrl } from "@/lib/utils/safe-url";

type UnknownRecord = Record<string, unknown>;

const TOPIC_TAG_TYPES = new Set(["right", "topic", "doctrine", "procedure", "case_type"]);

export function mapCclMetasearchRow(value: unknown, baseUrl: string): CclMetasearchItem {
  const row = objectRecord(value);
  const id = requiredString(row, "id");
  const slug = requiredString(row, "slug");
  const sourceKey = requiredString(row, "source_key");
  const jurisdiction = requiredString(row, "jurisdiction");
  const originalLanguage = requiredString(row, "original_language");
  const originalTitle = optionalString(row, "original_title");
  const koreanTitle = optionalString(row, "korean_title");
  const sourceMetadata = optionalRecord(row, "source_metadata");
  const summaryJson = optionalRecord(row, "summary_json");
  const summaryParts = summaryCore(summaryJson);
  const summary = truncatePlainText(summaryParts.join(" "), 1_200);
  const snippet = truncatePlainText(summaryParts[0] ?? "", 320);
  const tags = extractTags(row["article_tags"]);
  const summaryTags = stringArray(summaryJson?.["tags"]);
  const summaryCategories = stringArray(summaryJson?.["categories"]);
  const keywords = uniqueStrings([...tags.map((tag) => tag.name), ...summaryTags]);
  const topics = uniqueStrings([
    ...tags.filter((tag) => TOPIC_TAG_TYPES.has(tag.type)).map((tag) => tag.name),
    ...summaryCategories,
  ]);
  const decisionDate = isoDate(optionalString(row, "original_published_at"));
  const updatedAt = firstIsoTimestamp(row, ["summarized_at", "fetched_at", "discovered_at", "original_published_at"]);
  const originalUrl =
    safeExternalUrl(optionalString(row, "original_url")) ??
    safeExternalUrl(optionalString(row, "canonical_url")) ??
    null;
  const worldconsUrl = new URL(`/articles/${encodeURIComponent(slug)}`, normalizedBaseUrl(baseUrl)).toString();

  return {
    id,
    canonicalId: `worldcons:${id}`,
    title: koreanTitle || originalTitle || "제목 미상",
    originalTitle,
    countryCode: jurisdictionCodeFor(jurisdiction),
    countryName: displayJurisdictionLabel(jurisdiction),
    courtName: displaySourceLabel({
      sourceKey,
      name: optionalString(row, "institution_name"),
    }),
    sourceKey,
    caseNumber: caseNumberFor({ sourceKey, sourceMetadata, originalTitle, originalUrl }),
    decisionDate,
    decisionYear: decisionDate ? Number(decisionDate.slice(0, 4)) : null,
    originalLanguage,
    summary: summary || null,
    snippet: snippet || null,
    keywords,
    topics,
    originalUrl,
    worldconsUrl,
    detailUrl: worldconsUrl,
    updatedAt,
    relevanceScore: finiteNumber(row["relevance_score"]),
  };
}

function caseNumberFor(input: {
  sourceKey: string;
  sourceMetadata: UnknownRecord | null;
  originalTitle: string | null;
  originalUrl: string | null;
}) {
  const metadataCaseNumber = firstString(input.sourceMetadata, [
    "caseNumber",
    "case_number",
    "docketNumber",
    "docket_number",
    "decisionNumber",
    "resolutionNumber",
  ]);
  if (metadataCaseNumber) return metadataCaseNumber;

  const title = input.originalTitle ?? "";
  if (input.sourceKey === "fr-conseil-constitutionnel") {
    return title.match(/\bn[°º]\s*([0-9]{4}-[0-9]+(?:\s+[A-Z]{1,8})?)/iu)?.[1]?.trim() ?? null;
  }
  if (input.sourceKey === "es-tribunal-constitucional") {
    return title.match(/\b(?:SENTENCIA|AUTO|DECLARACI[ÓO]N)\s+([0-9]+\/[0-9]{4})/iu)?.[1]?.trim() ?? null;
  }
  if (input.sourceKey === "us-scotus") {
    const urlNumber = input.originalUrl?.match(/\/(\d{2,4}-\d+)(?:_[^/]*)?\.pdf(?:$|\?)/iu)?.[1];
    return urlNumber ?? title.match(/\b(?:No\.\s*)?(\d{2,4}-\d+)\b/u)?.[1] ?? null;
  }
  if (input.sourceKey === "de-bverfg") {
    return title.match(/\b\d+\s+Bv[A-Za-zÄÖÜäöü]+\s+\d+\/\d{2,4}\b/u)?.[0] ?? null;
  }

  return null;
}

function extractTags(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    const articleTag = objectRecordOrNull(entry);
    if (!articleTag) return [];
    const tagValues = Array.isArray(articleTag["tags"]) ? articleTag["tags"] : [articleTag["tags"]];

    return tagValues.flatMap((tagValue) => {
      const tag = objectRecordOrNull(tagValue);
      const name = tag ? optionalString(tag, "name") : null;
      if (!tag || !name) return [];
      return [{ name, type: optionalString(tag, "type") ?? "" }];
    });
  });
}

function summaryCore(summaryJson: UnknownRecord | null) {
  const summary = summaryJson ? objectRecordOrNull(summaryJson["summary"]) : null;
  return stringArray(summary?.["coreSummary"]);
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => truncatePlainText(item, 1_200))
    .filter(Boolean);
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = truncatePlainText(value, 160);
    if (!normalized) return false;
    const key = normalized.toLocaleLowerCase("ko-KR");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function truncatePlainText(value: string, maxLength: number) {
  const plain = value
    .replace(/<[^>]*>/gu, " ")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (plain.length <= maxLength) return plain;
  return `${plain.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function isoDate(value: string | null) {
  if (!value) return null;
  const direct = value.match(/^(\d{4}-\d{2}-\d{2})/u)?.[1];
  if (direct) return direct;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function firstIsoTimestamp(row: UnknownRecord, names: string[]) {
  for (const name of names) {
    const value = optionalString(row, name);
    if (!value) continue;
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
}

function normalizedBaseUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function firstString(record: UnknownRecord | null, names: string[]) {
  if (!record) return null;
  for (const name of names) {
    const value = optionalString(record, name);
    if (value) return value;
  }
  return null;
}

function finiteNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function requiredString(record: UnknownRecord, name: string) {
  const value = optionalString(record, name);
  if (!value) throw new Error(`Malformed cclmetasearch database row: ${name} is required.`);
  return value;
}

function optionalString(record: UnknownRecord, name: string) {
  const value = record[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalRecord(record: UnknownRecord, name: string) {
  return objectRecordOrNull(record[name]);
}

function objectRecord(value: unknown): UnknownRecord {
  const record = objectRecordOrNull(value);
  if (!record) throw new Error("Malformed cclmetasearch database row.");
  return record;
}

function objectRecordOrNull(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
}
