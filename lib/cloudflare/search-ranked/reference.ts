import {
  caseNumberKey,
  normalizeCaseNumber,
  type ConstitutionalSourceKey,
  type ExactCaseReference,
} from "@/lib/search/case-number";

/**
 * M7.3 primary exact-case reference parser.
 *
 * `worldcons_query_case_reference_v1` returns ONE reference using strict
 * precedence:
 *
 *   1. `neubauer|klimabeschluss` alias FIRST => de-bverfg 1 BvR 2656/18
 *   2. BVerfG display form
 *   3. France
 *   4. Spain
 *   5. US
 *
 * This mirrors that precedence exactly rather than reusing the multi-reference
 * `extractExactCaseReferences` semantics (whose ordering and alias placement
 * differ). `caseNumberKey`/`normalizeCaseNumber` are reused for key derivation so
 * the keys stay identical to the rest of the search domain.
 *
 * Documented divergence: the raw query is NFKC-normalized before matching
 * (Postgres matches the raw trimmed text) and JS `\b` word boundaries are
 * ASCII-oriented. Both are deterministic and only affect pathological inputs.
 */

const ALIAS_PATTERN = /\b(neubauer|klimabeschluss)\b/iu;
const BVERFG_DISPLAY_PATTERN = /\b([12]\s+Bv[A-Za-z]+\s+[0-9]+\s*\/\s*[0-9]{2,4})\b/iu;
const FRANCE_PATTERN = /\b([0-9]{4}-[0-9]+(?:[/_-][0-9]+)*(?:\s+(?:QPC|DC|AN|SEN))?)\b/iu;
const SPAIN_PATTERN = /\b([0-9]{1,4}\s*\/\s*[0-9]{4})\b/u;
const US_PATTERN = /\b(?:No\.\s*)?([0-9]{2,3}\s*-\s*[0-9]+)\b/iu;

/** The fixed alias target, identical to the SQL literal. */
export const BVERFG_CLIMATE_ALIAS_CASE_NUMBER = "1 BvR 2656/18" as const;

function referenceFor(sourceKey: ConstitutionalSourceKey, raw: string): ExactCaseReference | null {
  const caseNumber = normalizeCaseNumber(sourceKey, raw);
  const caseKey = caseNumberKey(sourceKey, raw);
  if (!caseNumber || !caseKey) return null;
  return { sourceKey, caseNumber, caseKey };
}

/**
 * Returns the single primary exact-case reference for a query, or `null` when no
 * recognized reference is present. Precedence is alias, BVerfG, France, Spain, US.
 */
export function primaryCaseReference(query: unknown): ExactCaseReference | null {
  if (typeof query !== "string") return null;
  const normalized = query.normalize("NFKC");

  if (ALIAS_PATTERN.test(normalized)) {
    const alias = referenceFor("de-bverfg", BVERFG_CLIMATE_ALIAS_CASE_NUMBER);
    if (alias) return alias;
  }

  const bverfg = normalized.match(BVERFG_DISPLAY_PATTERN);
  if (bverfg) {
    const reference = referenceFor("de-bverfg", bverfg[1]);
    if (reference) return reference;
  }

  const france = normalized.match(FRANCE_PATTERN);
  if (france) {
    const reference = referenceFor("fr-conseil-constitutionnel", france[1]);
    if (reference) return reference;
  }

  const spain = normalized.match(SPAIN_PATTERN);
  if (spain) {
    const reference = referenceFor("es-tribunal-constitucional", spain[1]);
    if (reference) return reference;
  }

  const us = normalized.match(US_PATTERN);
  if (us) {
    const reference = referenceFor("us-scotus", us[1]);
    if (reference) return reference;
  }

  return null;
}

/** True when the query carries a recognized primary exact-case reference. */
export function hasPrimaryCaseReference(query: unknown): boolean {
  return primaryCaseReference(query) !== null;
}
