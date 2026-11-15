import type { SummaryJson } from "@/lib/db/types";

/** Deterministic P3 pre-cutover review signals, NOT a legal truth classifier.
 * Never return source or summary text; a clean result is not a correctness signoff.
 */
export type LegalEvidenceCode =
  | "official_title_changed"
  | "korean_summary_missing"
  | "case_number_not_in_source"
  | "unsubstantiated_child_claim"
  | "unreliable_legal_terminology"
  | "unsupported_deportation_direction"
  | "applicant_nationality_attribution_review"
  | "judgment_effective_date_ambiguous"
  | "party_citation_marked_sic"
  | "garbled_french_social_security_law_name"
  | "reference_number_not_in_source"
  | "party_claim_attribution_review";

export interface LegalEvidenceFinding {
  code: LegalEvidenceCode;
  severity: "block" | "review";
}

export interface LegalEvidenceAudit {
  status: "pass" | "review" | "block";
  findings: LegalEvidenceFinding[];
  legalAccuracyVerified: false;
}

export interface SourceForLegalAudit {
  sourceKey: string;
  originalTitle?: string | null;
  cleanedText?: string | null;
}

const MINOR_IN_SOURCE = /\b(?:kind(?:er|es|ern|heit)?|minderjährig(?:e|en|er)?|child(?:ren)?|minor(?:s)?|juvenile(?:s)?|menor(?:es)?|niñ[oa]s?|infan(?:t|ce)s?|enfants?|mineur(?:e|s)?)\b|未成年|児童|미성년|아동/i;
const MINOR_IN_KOREAN = /(?:아동|미성년자?|어린이|어린아이|청소년)/;

function caseNumbers(text: string): string[] {
  const found = text.match(/\b(?:\d+\s*BvR\s*\d+\/\d+|\d{2}A\d{2,4}|20\d{2}[-–]\d{3,4}(?:\/\d{3,4})?\s*QPC|(?:AUTO|ATC)\s*\d+\/20\d{2})\b/gi) ?? [];
  return [...new Set(found.map(s => s.toLowerCase().replace(/\s+/g, "").replace(/–/g, "-")))];
}

export function auditLegalEvidence(source: SourceForLegalAudit, summary: SummaryJson): LegalEvidenceAudit {
  const sourceTitle = source.originalTitle ?? "";
  const original = [sourceTitle, source.cleanedText ?? ""].join("\n");
  const narrative = [
    summary.koreanTitle,
    ...summary.summary.coreSummary,
    summary.summary.background,
    summary.summary.caseStructure,
    summary.summary.implications,
    summary.summary.practicalNotes,
  ].join(" ");
  const findings: LegalEvidenceFinding[] = [];
  const add = (code: LegalEvidenceCode, severity: "block" | "review") => {
    if (!findings.some(f => f.code === code)) findings.push({ code, severity });
  };
  if (sourceTitle.trim() && summary.originalTitle?.trim() !== sourceTitle.trim()) add("official_title_changed", "block");
  if (!/[가-힣]/.test(summary.koreanTitle) || !summary.summary.coreSummary.some(p => /[가-힣]/.test(p))) {
    add("korean_summary_missing", "block");
  }
  const supported = new Set(caseNumbers(original));
  for (const number of caseNumbers(narrative)) {
    if (!supported.has(number)) add("case_number_not_in_source", "block");
  }
  if (MINOR_IN_KOREAN.test(narrative) && !MINOR_IN_SOURCE.test(original)) add("unsubstantiated_child_claim", "block");
  // These are specific known *wrong* Korean transcriptions of German legal
  // terms seen in an actual P3 canary, not a claim to validate all translations.
  if (source.sourceKey === "de-bverfg" && (
    (/\bAsyl(?:antrag|verfahren|bewerber|recht)?\b/i.test(original) && /아스일/.test(narrative))
    || (/\bSenat(?:s)?\b/i.test(original) && /제\s*\d+\s*센트/.test(narrative))
  )) add("unreliable_legal_terminology", "block");
  // Specific direction-of-removal error observed in the published Korean
  // baseline: the German court barred deportation OF the applicant, without
  // ordering or identifying "deportation TO Germany" in its holding.
  if (source.sourceKey === "de-bverfg"
    && /Die Abschiebung der Beschwerdeführerin/i.test(original)
    && !/Die Abschiebung der Beschwerdeführerin nach Deutschland/i.test(original)
    && /독일로(?:의)?\s*(?:강제)?(?:송환|추방)/.test(narrative)) {
    add("unsupported_deportation_direction", "block");
  }
  // This court decision calls her a Somali national explicitly "according to
  // her own statements" (nach ihren Angaben). Do not silently promote a
  // litigant-reported fact to a judicially verified attribute.
  if (source.sourceKey === "de-bverfg"
    && /nach\s+ihren\s+Angaben\s+somalische\s+Staatsangehörige/i.test(original)
    && /소말리아\s*국적(?:의)?\s*(?:신청인|여성|원고)/.test(narrative)
    && !/(?:신청인|본인)(?:의)?\s*(?:진술|주장|설명)|자신의\s*(?:진술|주장)|스스로\s*밝힌/.test(narrative)) {
    add("applicant_nationality_attribution_review", "review");
  }
  if (source.sourceKey === "fr-conseil-constitutionnel"
    && /date de la publication de la présente décision/i.test(original)
    && /(?:공포일부터\s*(?:폐지|무효)|공포일부터\s*효력|법률의\s*공포일)/.test(narrative)) {
    add("judgment_effective_date_ambiguous", "review");
  }
  // Observed in the public 2026-1230/1231 QPC summary:
  // "사회보장재정1법" is not a supported Korean rendering of the source law name.
  if (source.sourceKey === "fr-conseil-constitutionnel"
    && /financement de la sécurité sociale/i.test(original)
    && /사회보장재정\s*\d+\s*법/.test(narrative)) {
    add("garbled_french_social_security_law_name", "review");
  }
  if (source.sourceKey === "es-tribunal-constitucional"
    && /\bart\.\s*219\.1\b[\s\S]{0,45}\[\s*sic\b/i.test(original)
    && summary.summary.referencedProvisions.some(p => /219\.1\b/i.test(p.article))) {
    add("party_citation_marked_sic", "review");
  }
  for (const provision of summary.summary.referencedProvisions) {
    if ((provision.article.match(/\b\d{4,}\b/g) ?? []).some(number => !original.includes(number))) {
      add("reference_number_not_in_source", "review");
    }
  }
  // This is a manual attribution REVIEW trigger, not a claim of fabrication.
  if (source.sourceKey === "us-scotus"
    && /respondents?\s+(?:claimed|argued|contended|alleged)/i.test(original)
    && /Article\s+I,\s*Section\s+1/i.test(original)
    && summary.summary.referencedProvisions.some(p => /article\s*i|제\s*1\s*조/i.test(p.article))) {
    add("party_claim_attribution_review", "review");
  }
  return {
    status: findings.some(f => f.severity === "block") ? "block" : findings.length ? "review" : "pass",
    findings,
    legalAccuracyVerified: false,
  };
}
