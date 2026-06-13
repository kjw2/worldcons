import type { GlossaryTerm } from "@/lib/db/types";
import { displayJurisdictionLabel } from "@/lib/ui/source-labels";

const sourceLanguageLabels: Record<string, string> = {
  Germany: "독일어",
  "United States": "영어",
  France: "프랑스어",
  Spain: "스페인어",
};

export function glossaryJurisdictionLabel(term: GlossaryTerm) {
  if (!term.jurisdiction) return "공통";
  return displayJurisdictionLabel(term.jurisdiction);
}

export function glossarySourceLanguageLabel(term: GlossaryTerm) {
  if (!term.jurisdiction) return "독일어·영어·프랑스어";
  return sourceLanguageLabels[term.jurisdiction] ?? "원문 언어";
}
