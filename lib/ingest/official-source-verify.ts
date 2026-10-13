/**
 * Runtime-neutral, fixture-free official-source identity validators shared by
 * the native crawler and the operator single-case staged canary.
 *
 * These functions encode the *identity contracts* that make an official
 * document trustworthy: an official host, an official URL shape, and the exact
 * identity that must appear in the fetched body (a German ECLI, a US docket).
 * They perform no network or database work, so both the Worker path and a
 * Node-side canary planner/test can assert on the identical bytes.
 *
 * `workers/async-pipeline/src/native-crawler.ts` and `scotus-pdf.ts` import
 * these and re-export/wrap them so the crawler and the canary can never diverge.
 */

/** A parsed German BVerfG decision identity derived from an official path. */
export interface BverfgDecisionIdentity {
  ecli: string;
  decisionId: string;
  publishedAt: string;
}

/** A parsed US SCOTUS slip-opinion PDF identity derived from an official path. */
export interface ScotusPdfIdentity {
  /** Canonical docket as it must appear in the PDF header (for example `26A388`, `24-43`). */
  docket: string;
  term: string;
}

const OFFICIAL_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "de-bverfg": ["bundesverfassungsgericht.de", "bverfg.de"],
  "us-scotus": ["supremecourt.gov"],
  "fr-conseil-constitutionnel": ["conseil-constitutionnel.fr"],
  "es-tribunal-constitucional": ["hj.tribunalconstitucional.es"],
};

/** True only when `url` is an HTTPS URL on the exact official host (or a subdomain). */
export function isOfficialHost(sourceKey: string, url: string): boolean {
  const allowed = OFFICIAL_HOSTS[sourceKey];
  if (!allowed) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return allowed.some((root) => host === root || host.endsWith(`.${root}`));
}

/**
 * Parses the official BVerfG `SharedDocs/Entscheidungen` decision identity from
 * a URL. The official site serves the same decision as an extensionless URL
 * (`.../rs20260521_2bvr109622`) and with `.html`, and may append a query suffix
 * (`?nn=68112`). Both the extension and query are cosmetic: they never change
 * the ECLI. Identity therefore derives from the path stem only and ignores the
 * optional extension/query, while still rejecting a mismatched path date.
 */
export function bverfgDecisionIdentity(url: string): BverfgDecisionIdentity | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = pathname.match(
    /^\/SharedDocs\/Entscheidungen\/DE\/(20\d{2})\/(\d{2})\/([a-z]{2})(20\d{2})(\d{2})(\d{2})_([a-z0-9]+?)(?:\.html?)?$/i,
  );
  if (!match || match[1] !== match[4] || match[2] !== match[5]) return null;
  return {
    ecli: `ECLI:DE:BVerfG:${match[1]}:${match[3].toLowerCase()}${match[4]}${match[5]}${match[6]}.${match[7].toLowerCase()}`,
    decisionId: `${match[4]}${match[5]}${match[6]}_${match[7]}`.toLowerCase(),
    publishedAt: `${match[4]}-${match[5]}-${match[6]}T00:00:00.000Z`,
  };
}

/**
 * Finds the first exact in-body German ECLI token. The body match is compared
 * against the URL-derived identity by the caller so a page that does not carry
 * the decision's own ECLI can never be accepted.
 */
export function extractBverfgEcliFromBody(bodyText: string): string | null {
  return bodyText.match(/\bECLI:DE:BVerfG:20\d{2}:[a-z]{2}20\d{6}\.[a-z0-9]+\b/i)?.[0]?.toLowerCase() ?? null;
}

/**
 * True only when the final official URL and the discovery URL describe the
 * *same* BVerfG decision and the fetched body carries exactly that ECLI.
 */
export function verifyBverfgOfficialText(
  bodyText: string,
  finalUrl: string,
  discoveredUrl: string,
): { ecli: string; publishedAt: string } | null {
  const expected = bverfgDecisionIdentity(finalUrl);
  const discovered = bverfgDecisionIdentity(discoveredUrl);
  if (!expected || !discovered || expected.decisionId !== discovered.decisionId) return null;
  const actual = extractBverfgEcliFromBody(bodyText);
  if (!actual || actual !== expected.ecli.toLowerCase()) return null;
  return { ecli: expected.ecli, publishedAt: expected.publishedAt };
}

/** True only for an official `supremecourt.gov/opinions/<term>pdf/*.pdf` URL. */
export function isOfficialScotusPdfUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname.toLowerCase() === "supremecourt.gov" || url.hostname.toLowerCase().endsWith(".supremecourt.gov")) &&
      /^\/opinions\/\d{2}pdf\/[^/]+\.pdf$/i.test(url.pathname) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/**
 * Parses a SCOTUS slip-opinion PDF identity from an official URL path
 * (`/opinions/25pdf/26a388_q86b.pdf` -> term `25`, filename stem). The docket
 * itself is NOT encoded in the filename for in-chambers applications, so the
 * caller must supply the expected docket from the official listing and compare
 * it against the PDF body.
 */
export function scotusPdfIdentity(input: string): ScotusPdfIdentity | null {
  if (!isOfficialScotusPdfUrl(input)) return null;
  const pathname = new URL(input).pathname;
  const match = pathname.match(/^\/opinions\/(\d{2})pdf\/([^/]+)\.pdf$/i);
  if (!match) return null;
  return { term: match[1], docket: match[2].toLowerCase() };
}

/**
 * Normalizes a SCOTUS docket to its canonical comparison form. Certiorari and
 * appeal dockets use a hyphenated number (`24-43`); in-chambers application and
 * comparable letter dockets omit the hyphen (`26A388`, `25A1314`).
 */
export function normalizeScotusDocket(value: string): string | null {
  const canonical = value.replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\s+/g, "").toUpperCase();
  if (/^\d{1,3}-\d{1,6}$/.test(canonical)) return canonical;
  if (/^\d{1,3}[A-Z]\d{1,6}$/.test(canonical)) return canonical;
  return null;
}

/**
 * True only when `docket` appears as a `No.`/`Nos.` reference in the PDF body
 * header, using the same optional-space/optional-hyphen normalization the PDF
 * extractor uses. This is the in-body identity proof for a SCOTUS opinion.
 */
export function scotusBodyDocketMatches(bodyText: string, docket: string): boolean {
  const expected = normalizeScotusDocket(docket);
  if (!expected) return false;
  const header = bodyText.slice(0, 12_000).replace(/[\u2010-\u2015\u2212]/g, "-");
  const matches = [...header.matchAll(/\bNos?\.\s*(\d{1,3})\s*-?\s*([A-Z]?\d{1,6})\b/gi)];
  return matches.some((match) => `${match[1]}-${match[2]}`.replace(/-([A-Z])/, "$1").toUpperCase() === expected);
}
