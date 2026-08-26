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
const FRANCE_PATTERN = /\b(\d{4}-\d+(?:[/_-]\d+)*(?:\s+(?:QPC|DC|AN|SEN))?)\b/iu;
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
    .replace(/\s+(qpc|dc|an|sen)$/iu, (_, suffix: string) => ` ${suffix.toUpperCase()}`);
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
