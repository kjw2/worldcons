import type { GlossaryTerm } from "@/lib/db/types";

const aliasGroups = [
  ["평등원칙", "평등 원칙", "Equal Protection", "Gleichheitssatz"],
  ["선거비용", "선거 비용", "Comptes de campagne"],
  ["피선거권 박탈", "피선거권박탈", "Ineligibilite", "Inéligibilité"],
  ["위헌결정", "위헌 결정", "Unconstitutionality"],
  ["선거무효", "선거 무효", "선거무효소송", "Election annulment"],
  ["헌법위원회", "프랑스 헌법위원회", "Conseil constitutionnel", "Constitutional Council"],
  ["독일 연방헌법재판소", "독일헌법재판소", "Bundesverfassungsgericht"],
  ["미국 연방대법원", "미국 연방 대법원", "미국 대법원", "미 연방대법원", "미 대법원", "연방대법원", "Supreme Court of the United States", "SCOTUS"],
  ["우선적 위헌심사절차", "우선적 위헌심사", "QPC", "Question prioritaire de constitutionnalite"],
  ["연방헌법재판소법", "BVerfGG", "Bundesverfassungsgerichtsgesetz"],
  ["독일 기본법", "Grundgesetz"],
  ["표현의 자유", "Free Speech", "Freedom of expression", "Meinungsfreiheit"],
  ["재판청구권", "Access to court", "Right of access to court"],
  ["적법절차", "Due Process"],
  ["가처분", "Interim measures", "Einstweilige Anordnung"],
  ["각하", "Inadmissibility", "Irrecevabilite", "Irrecevabilité"],
  ["불수리", "Non-admission", "Nichtannahme"],
  ["보충성 원칙", "Subsidiarity", "Subsidiaritat", "Subsidiarität"],
  ["정치자금", "Political finance"],
  ["재산권", "Property right", "Property"],
];

const aliasToCanonical = new Map<string, string>();
const canonicalToAliases = new Map<string, string[]>();

for (const group of aliasGroups) {
  const [canonical, ...aliases] = group;
  const allNames = [canonical, ...aliases];
  canonicalToAliases.set(canonical, allNames);
  for (const name of allNames) {
    aliasToCanonical.set(tagAliasKey(name), canonical);
  }
}

export function tagAliasKey(input: string) {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[#'’`´·.,:;()[\]{}]/g, "")
    .replace(/[\s\-_]+/g, "");
}

export function canonicalTagName(input: string) {
  return aliasToCanonical.get(tagAliasKey(input)) ?? input.trim();
}

export function expandRelatedTagNames(tags: string[]) {
  const names = new Set<string>();
  for (const tag of tags) {
    const canonical = canonicalTagName(tag);
    names.add(tag);
    names.add(canonical);
    for (const alias of canonicalToAliases.get(canonical) ?? []) {
      names.add(alias);
    }
  }
  return [...names].filter(Boolean);
}

export function glossaryCoveredTagKeys(terms: GlossaryTerm[]) {
  const keys = new Set<string>();
  for (const term of terms) {
    keys.add(tagAliasKey(term.slug));
    keys.add(tagAliasKey(term.term));
    if (term.koreanTerm) keys.add(tagAliasKey(term.koreanTerm));
    for (const tag of expandRelatedTagNames(term.relatedTags)) {
      keys.add(tagAliasKey(tag));
    }
  }
  return keys;
}
