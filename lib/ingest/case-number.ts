import { normalizeCaseNumber } from "@/lib/search/case-number";

type MetadataRecord = Record<string, unknown>;

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function plainDecisionNumber(value?: string) {
  return value
    ?.replace(/^\s*(?:Décision|Decision)\s+n[°ºo]?\s*/iu, "")
    .replace(/\s+/g, " ")
    .trim() || undefined;
}

function bverfgCaseNumberFromText(value: string) {
  const displayed = value.match(/\b(?:1|2)\s+Bv[A-Za-zÄÖÜäöü]+\s+\d+\/\d{2,4}\b/u)?.[0];
  if (displayed) return displayed;

  const compact = value.match(/[_./]([12])bv([a-z]+)(\d{4})(\d{2})(?:\.html)?\b/i);
  if (!compact) return undefined;

  const number = String(Number(compact[3]));
  const suffix = `${compact[2].slice(0, 1).toUpperCase()}${compact[2].slice(1).toLowerCase()}`;
  return `${compact[1]} Bv${suffix} ${number}/${compact[4]}`;
}

function titleCaseNumber(sourceKey: string, title?: string) {
  if (!title) return undefined;
  if (sourceKey === "fr-conseil-constitutionnel") {
    return title.match(/\bn[°ºo]?\s*([0-9]{4}-[0-9]+(?:[/_-][0-9]+)*(?:\s+[A-Z]{1,8})?)/iu)?.[1]?.trim();
  }
  if (sourceKey === "es-tribunal-constitucional") {
    return title.match(/\b(?:SENTENCIA|AUTO|DECLARACI[ÓO]N)\s+([0-9]+\/[0-9]{4})/iu)?.[1]?.trim();
  }
  if (sourceKey === "us-scotus") {
    return title.match(/\b(?:No\.\s*)?(\d{2,4}-\d+)\b/u)?.[1]?.trim();
  }
  if (sourceKey === "de-bverfg") return bverfgCaseNumberFromText(title);
  return undefined;
}

function urlCaseNumber(sourceKey: string, url?: string) {
  if (!url) return undefined;
  if (sourceKey === "de-bverfg") return bverfgCaseNumberFromText(url);
  if (sourceKey === "us-scotus") return url.match(/\/(\d{2,4}-\d+)(?:_[^/]*)?\.pdf(?:$|\?)/iu)?.[1];
  return undefined;
}

export function caseNumberFromArticle(input: {
  sourceKey: string;
  metadata?: MetadataRecord | null;
  title?: string | null;
  url?: string | null;
}) {
  const metadata = input.metadata ?? {};
  const direct = stringValue(metadata.caseNumber) ?? stringValue(metadata.case_number);
  if (direct) return normalizeCaseNumber(input.sourceKey, direct) ?? direct;

  const alias =
    stringValue(metadata.docketNumber) ??
    stringValue(metadata.docket_number) ??
    stringValue(metadata.docket) ??
    plainDecisionNumber(stringValue(metadata.decisionNumber)) ??
    stringValue(metadata.resolutionNumber);
  if (alias) return normalizeCaseNumber(input.sourceKey, alias) ?? alias;

  const inferred = titleCaseNumber(input.sourceKey, stringValue(input.title)) ?? urlCaseNumber(input.sourceKey, stringValue(input.url));
  return inferred ? normalizeCaseNumber(input.sourceKey, inferred) ?? inferred : undefined;
}

export function withCaseNumberMetadata(input: {
  sourceKey: string;
  metadata?: MetadataRecord | null;
  title?: string | null;
  url?: string | null;
}) {
  const metadata = input.metadata ?? {};
  const caseNumber = caseNumberFromArticle(input);
  return caseNumber ? { ...metadata, caseNumber } : metadata;
}
