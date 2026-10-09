export type ConstitutionalSourceKey =
  | "de-bverfg"
  | "fr-conseil-constitutionnel"
  | "es-tribunal-constitucional"
  | "us-scotus";

export type ExactCaseReference = {
  sourceKey: ConstitutionalSourceKey;
  caseNumber: string;
  caseKey: string;
};

const BVERFG_DISPLAY_PATTERN = /\b(\d{1,2})\s+Bv([A-Za-z]+)\s+(\d{1,7})\s*\/\s*(\d{2,4})\b/iu;
const BVERFG_URL_PATTERN = /(?:^|[_./])([12])bv([a-z]+)(\d{4})(\d{2})(?:\.html)?(?:$|[?#])/iu;
const FRANCE_PATTERN = /\b(\d{4}-\d+(?:[/_-]\d+)*(?:\s+(?:QPC|DC|L|AN|SEN))?)\b/iu;
const SPAIN_PATTERN = /\b(\d{1,4})\s*\/\s*(\d{4})\b/iu;
const US_PATTERN = /\b(?:No\.\s*)?(\d{2,3})\s*-\s*(\d+)\b/iu;

function yearSuffix(value: string) {
  return value.length === 4 ? value.slice(-2) : value.padStart(2, "0");
}

function normalizeBverfg(value: string) {
  const normalized = value.normalize("NFKC");
  const displayed = normalized.match(BVERFG_DISPLAY_PATTERN);
  if (displayed) {
    const suffix = displayed[2];
    return `${Number(displayed[1])} Bv${suffix.slice(0, 1).toUpperCase()}${suffix.slice(1).toLowerCase()} ${Number(displayed[3])}/${yearSuffix(displayed[4])}`;
  }

  const compact = normalized.match(BVERFG_URL_PATTERN);
  if (!compact) return undefined;
  const suffix = compact[2];
  return `${Number(compact[1])} Bv${suffix.slice(0, 1).toUpperCase()}${suffix.slice(1).toLowerCase()} ${Number(compact[3])}/${compact[4]}`;
}

function normalizeFrance(value: string) {
  const match = value.normalize("NFKC").match(FRANCE_PATTERN);
  if (!match) return undefined;
  return match[1]
    .replace(/_/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(qpc|dc|l|an|sen)$/iu, (_, suffix: string) => ` ${suffix.toUpperCase()}`);
}

function normalizeSpain(value: string) {
  const match = value.normalize("NFKC").match(SPAIN_PATTERN);
  if (!match) return undefined;
  return `${Number(match[1])}/${match[2]}`;
}

function normalizeUs(value: string) {
  const match = value.normalize("NFKC").match(US_PATTERN);
  if (!match) return undefined;
  return `${Number(match[1])}-${Number(match[2])}`;
}

export function normalizeCaseNumber(sourceKey: string, value?: string | null) {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  if (sourceKey === "de-bverfg") return normalizeBverfg(candidate);
  if (sourceKey === "fr-conseil-constitutionnel") return normalizeFrance(candidate);
  if (sourceKey === "es-tribunal-constitucional") return normalizeSpain(candidate);
  if (sourceKey === "us-scotus") return normalizeUs(candidate);
  return candidate;
}

export function caseNumberKey(sourceKey: string, value?: string | null) {
  const canonical = normalizeCaseNumber(sourceKey, value);
  if (!canonical) return undefined;
  return canonical.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/gu, "");
}

type CaseMetadataRecord = Record<string, unknown>;

/**
 * Keys the ingest/backfill pipeline owns for a case number. They mirror the
 * Postgres generated `case_key` expression and the sourceInventory payload, so
 * only these fields are treated as authoritative.
 */
const AUTHORITATIVE_CASE_NUMBER_KEYS = [
  "caseNumber",
  "case_number",
  "docketNumber",
  "docket_number",
  "docket",
  "decisionNumber",
  "resolutionNumber",
] as const;

function toCaseMetadataRecord(value: unknown): CaseMetadataRecord | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as CaseMetadataRecord)
        : null;
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as CaseMetadataRecord)
    : null;
}

function firstMetadataCaseNumber(record: CaseMetadataRecord): string | undefined {
  const inventory = toCaseMetadataRecord(record.sourceInventory);
  const candidates: unknown[] = AUTHORITATIVE_CASE_NUMBER_KEYS.map((key) => record[key]);
  if (inventory) candidates.push(...AUTHORITATIVE_CASE_NUMBER_KEYS.map((key) => inventory[key]));
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const candidate = value.trim();
    if (candidate) return candidate;
  }
  return undefined;
}

/**
 * Canonical case number from one authoritative metadata payload. `metadata` may
 * be D1 canonical JSON text or an already-revived object; only the
 * pipeline-owned case keys (and their `sourceInventory` copies) are read, never
 * arbitrary article body text.
 */
export function canonicalCaseNumberFromMetadata(sourceKey: string, metadata: unknown): string | undefined {
  const record = toCaseMetadataRecord(metadata);
  if (!record) return undefined;
  const raw = firstMetadataCaseNumber(record);
  return raw ? normalizeCaseNumber(sourceKey, raw) : undefined;
}

/**
 * Canonical case number for one public article row. Prefers the official
 * original title for France (whose historical metadata `decisionNumber` may be
 * truncated, e.g. "n° 2026-335 " missing the "L" suffix), otherwise the
 * pipeline-owned authoritative metadata keys. Mirrors the `projectionCaseNumbers`
 * precedence so public reads and the search projection agree. Never reads a URL
 * or arbitrary body text.
 */
export function canonicalArticleCaseNumber(input: {
  sourceKey?: string | null;
  originalTitle?: string | null;
  metadata?: unknown;
}): string | undefined {
  const sourceKey = input.sourceKey ?? "";
  if (sourceKey === "fr-conseil-constitutionnel" && input.originalTitle) {
    const fromTitle = normalizeCaseNumber(sourceKey, input.originalTitle);
    if (fromTitle) return fromTitle;
  }
  return authoritativeCaseMetadata(sourceKey, input.metadata)?.caseNumber;
}

/**
 * Derives the canonical `{ caseNumber, caseKey }` from the first authoritative
 * metadata container that carries a recognizable case number. Each container may
 * itself be the metadata object or wrap it under `sourceMetadata`/`case`.
 */
export function authoritativeCaseMetadata(
  sourceKey: string,
  ...containers: readonly unknown[]
): { caseNumber: string; caseKey: string } | undefined {
  for (const container of containers) {
    const record = toCaseMetadataRecord(container);
    if (!record) continue;
    const candidates = [
      record,
      toCaseMetadataRecord(record.sourceMetadata),
      toCaseMetadataRecord(record.case),
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const caseNumber = canonicalCaseNumberFromMetadata(sourceKey, candidate);
      const caseKey = caseNumberKey(sourceKey, caseNumber);
      if (caseNumber && caseKey) return { caseNumber, caseKey };
    }
  }
  return undefined;
}

function reference(sourceKey: ConstitutionalSourceKey, raw: string): ExactCaseReference | null {
  const caseNumber = normalizeCaseNumber(sourceKey, raw);
  const caseKey = caseNumberKey(sourceKey, raw);
  return caseNumber && caseKey ? { sourceKey, caseNumber, caseKey } : null;
}

export function extractExactCaseReferences(query: string): ExactCaseReference[] {
  const normalized = query.normalize("NFKC");
  const references: ExactCaseReference[] = [];

  for (const match of normalized.matchAll(new RegExp(BVERFG_DISPLAY_PATTERN.source, "giu"))) {
    const item = reference("de-bverfg", match[0]);
    if (item) references.push(item);
  }

  if (/\b(?:neubauer|klimabeschluss)\b/iu.test(normalized)) {
    const item = reference("de-bverfg", "1 BvR 2656/18");
    if (item) references.push(item);
  }

  for (const match of normalized.matchAll(new RegExp(FRANCE_PATTERN.source, "giu"))) {
    const item = reference("fr-conseil-constitutionnel", match[0]);
    if (item) references.push(item);
  }
  for (const match of normalized.matchAll(new RegExp(SPAIN_PATTERN.source, "giu"))) {
    const item = reference("es-tribunal-constitucional", match[0]);
    if (item) references.push(item);
  }
  for (const match of normalized.matchAll(new RegExp(US_PATTERN.source, "giu"))) {
    const item = reference("us-scotus", match[0]);
    if (item) references.push(item);
  }

  const seen = new Set<string>();
  return references.filter((item) => {
    const key = `${item.sourceKey}:${item.caseKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function hasExactCaseReference(query: string) {
  return extractExactCaseReferences(query).length > 0;
}
