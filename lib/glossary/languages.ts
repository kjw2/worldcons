import type { GlossaryTerm } from "@/lib/db/types";

const jurisdictionLabels: Record<string, string> = {
  Germany: "독일",
  "United States": "미국",
  France: "프랑스",
};

const sourceLanguageLabels: Record<string, string> = {
  Germany: "독일어",
  "United States": "영어",
  France: "프랑스어",
};

export function glossaryJurisdictionLabel(term: GlossaryTerm) {
  if (!term.jurisdiction) return "공통";
  return jurisdictionLabels[term.jurisdiction] ?? term.jurisdiction;
}

export function glossarySourceLanguageLabel(term: GlossaryTerm) {
  if (!term.jurisdiction) return "독일어·영어·프랑스어";
  return sourceLanguageLabels[term.jurisdiction] ?? "원문 언어";
}
