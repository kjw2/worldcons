import { createHash } from "node:crypto";
import { load } from "cheerio";

export const US_CONSTITUTION_ANNOTATED_FLAG = "CASE_CATALOG_US_CONAN_ENABLED";
export const US_CONSTITUTION_ANNOTATED_TABLE_URL =
  "https://constitution.congress.gov/resources/cases-cited/";

export type UsCourtClassification = "scotus_candidate" | "lower_federal" | "state_or_other" | "unknown";
export type ConstitutionalRelevanceStatus = "candidate" | "verified" | "uncertain" | "rejected";

export interface ConstitutionAnnotatedEssayReference {
  essayId: string;
  title: string;
  url: string;
}

export interface ConstitutionAnnotatedCandidate {
  stableCandidateKey: string;
  caseName: string;
  citation: string;
  normalizedCitation: string;
  courtClassification: UsCourtClassification;
  constitutionalRelevanceStatus: "candidate";
  candidateBasis: "constitution_annotated_table_citation";
  essayReferences: ConstitutionAnnotatedEssayReference[];
  priority: number;
  priorityReasons: string[];
}

export interface ConstitutionAnnotatedVerificationEvidence {
  officialScotusIdentityVerified: boolean;
  constitutionalEssayContextVerified: boolean;
  officialAuthorityVerified: boolean;
  constitutionalHoldingVerified: boolean;
  identityRejected?: boolean;
}

export interface ConstitutionAnnotatedVerificationResult {
  status: ConstitutionalRelevanceStatus;
  blocking: string[];
}

function explicitTrue(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

export function constitutionAnnotatedDiscoveryEnabled(
  environment: Record<string, string | undefined> = process.env,
) {
  return explicitTrue(environment[US_CONSTITUTION_ANNOTATED_FLAG]);
}

export function assertConstitutionAnnotatedDiscoveryEnabled(
  environment: Record<string, string | undefined> = process.env,
) {
  if (!constitutionAnnotatedDiscoveryEnabled(environment)) {
    throw new Error("case_backfill.us_conan_disabled");
  }
}

function normalizeSpace(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeUsCaseCitation(value: string) {
  return normalizeSpace(value)
    .replace(/\bU\.\s*S\.\b/gi, "U.S.")
    .replace(/\bF\.\s*Supp\.\b/gi, "F. Supp.")
    .replace(/\bF\.\s*(\d+d)\b/gi, "F.$1");
}

const U_S_REPORTS_PATTERN = /^\d+\s+U\.\s*S\.\s+(?:\([^)]+\)\s+)?\d+(?:\s+\(\d{4}\))?$/i;
const LOWER_FEDERAL_PATTERN = /\b(?:F\.\s*Supp\.?|F\.\s*App'?x|F\.\s*\d+d|Fed\.\s*Cl\.)\s*\d*\b|\b(?:D\.|N\.D\.|S\.D\.|E\.D\.|W\.D\.|C\.D\.)[A-Z.]*\b|\b\d+(?:st|nd|rd|th)\s+Cir\.\b/i;
const STATE_REPORTER_PATTERN = /\b(?:A\.|N\.E\.|N\.W\.|P\.|S\.E\.|S\.W\.|So\.)\s*\d*d?\s+\d+\b/i;

export function classifyUsCaseCitation(value: string): UsCourtClassification {
  const citation = normalizeUsCaseCitation(value);
  if (U_S_REPORTS_PATTERN.test(citation)) return "scotus_candidate";
  if (LOWER_FEDERAL_PATTERN.test(citation)) return "lower_federal";
  if (STATE_REPORTER_PATTERN.test(citation)) return "state_or_other";
  return "unknown";
}

export function isConstitutionAnnotatedChallengePage(html: string) {
  const sample = html.slice(0, 200_000).toLowerCase();
  return sample.includes("<title>just a moment...</title>")
    || sample.includes("cf-chl-")
    || sample.includes("enable javascript and cookies to continue");
}

function citationFromText(value: string) {
  const text = normalizeSpace(value);
  const match = text.match(/\b\d+\s+(?:U\.\s*S\.|F\.\s*Supp\.?\s*(?:\d+d)?|F\.\s*(?:2d|3d|4th)|F\.\s*App'?x|S\.\s*Ct\.|A\.\s*\d*d?|N\.E\.\s*\d*d?|N\.W\.\s*\d*d?|P\.\s*\d*d?|S\.E\.\s*\d*d?|S\.W\.\s*\d*d?|So\.\s*\d*d?)\s+\d+(?:\s+\([^)]+\))?/i);
  return match ? normalizeUsCaseCitation(match[0]) : null;
}

function caseNameFromText(value: string, citation: string) {
  const text = normalizeSpace(value);
  const index = text.toLowerCase().indexOf(citation.toLowerCase());
  if (index < 0) return text;
  return text.slice(0, index).replace(/[\s,;]+$/, "").trim();
}

function officialEssayReference(href: string, title: string): ConstitutionAnnotatedEssayReference | null {
  try {
    const url = new URL(href, US_CONSTITUTION_ANNOTATED_TABLE_URL);
    if (url.protocol !== "https:" || url.hostname !== "constitution.congress.gov") return null;
    const match = url.pathname.match(/^\/browse\/essay\/[^/]+\/(ALDE_[A-Z0-9_]+)\/?$/i);
    if (!match) return null;
    return {
      essayId: match[1].toUpperCase(),
      title: normalizeSpace(title),
      url: url.toString(),
    };
  } catch {
    return null;
  }
}

function candidateKey(normalizedCitation: string) {
  return `conan:${createHash("sha256").update(normalizedCitation.toLowerCase()).digest("hex").slice(0, 24)}`;
}

export function applyConstitutionAnnotatedPriority(
  candidate: ConstitutionAnnotatedCandidate,
  priorityCitations: ReadonlySet<string>,
) {
  const normalizedPriority = new Set([...priorityCitations].map((value) => normalizeUsCaseCitation(value).toLowerCase()));
  if (!normalizedPriority.has(candidate.normalizedCitation.toLowerCase())) return candidate;
  return {
    ...candidate,
    priority: Math.max(candidate.priority, 100),
    priorityReasons: [...new Set([...candidate.priorityReasons, "reviewed_redistricting_landmark_seed"])],
  };
}

export function parseConstitutionAnnotatedCasesHtml(html: string) {
  if (isConstitutionAnnotatedChallengePage(html)) {
    throw new Error("us_conan.source_challenge");
  }
  const $ = load(html);
  const byCitation = new Map<string, ConstitutionAnnotatedCandidate>();

  $("table tbody tr, table tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 2) return;
    const caseCell = $(cells[0]);
    const caseText = normalizeSpace(caseCell.text());
    const citation = caseCell.attr("data-case-citation")?.trim() || citationFromText(caseText);
    if (!citation) return;
    const normalizedCitation = normalizeUsCaseCitation(citation);
    const caseName = caseCell.attr("data-case-name")?.trim() || caseNameFromText(caseText, citation);
    if (!caseName) return;

    const essayReferences: ConstitutionAnnotatedEssayReference[] = [];
    $(row).find("a[href]").each((__, anchor) => {
      const reference = officialEssayReference($(anchor).attr("href") ?? "", $(anchor).text());
      if (reference) essayReferences.push(reference);
    });
    const key = normalizedCitation.toLowerCase();
    const existing = byCitation.get(key);
    const mergedReferences = [...(existing?.essayReferences ?? []), ...essayReferences]
      .filter((reference, index, all) => all.findIndex((other) => other.essayId === reference.essayId) === index);
    byCitation.set(key, {
      stableCandidateKey: candidateKey(normalizedCitation),
      caseName: existing?.caseName ?? normalizeSpace(caseName),
      citation: normalizedCitation,
      normalizedCitation,
      courtClassification: classifyUsCaseCitation(normalizedCitation),
      constitutionalRelevanceStatus: "candidate",
      candidateBasis: "constitution_annotated_table_citation",
      essayReferences: mergedReferences,
      priority: existing?.priority ?? 0,
      priorityReasons: existing?.priorityReasons ?? [],
    });
  });

  if (byCitation.size === 0) throw new Error("us_conan.inventory_empty_or_unrecognized");
  return [...byCitation.values()].sort((left, right) => left.normalizedCitation.localeCompare(right.normalizedCitation));
}

export function verifyConstitutionAnnotatedCandidate(
  candidate: ConstitutionAnnotatedCandidate,
  evidence: ConstitutionAnnotatedVerificationEvidence,
): ConstitutionAnnotatedVerificationResult {
  if (candidate.courtClassification === "lower_federal" || candidate.courtClassification === "state_or_other" || evidence.identityRejected) {
    return { status: "rejected", blocking: ["not_verified_scotus_identity"] };
  }
  const blocking: string[] = [];
  if (candidate.courtClassification !== "scotus_candidate" || !evidence.officialScotusIdentityVerified) {
    blocking.push("official_scotus_identity_required");
  }
  if (candidate.essayReferences.length === 0 || !evidence.constitutionalEssayContextVerified) {
    blocking.push("constitutional_essay_context_required");
  }
  if (!evidence.officialAuthorityVerified) blocking.push("official_authority_required");
  if (!evidence.constitutionalHoldingVerified) blocking.push("constitutional_holding_required");
  return blocking.length === 0
    ? { status: "verified", blocking: [] }
    : { status: "uncertain", blocking };
}
