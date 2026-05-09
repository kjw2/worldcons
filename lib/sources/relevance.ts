import type { NormalizedArticle } from "@/lib/sources/types";

export const CONSTITUTIONAL_KEYWORDS = [
  "constitution",
  "constitutional",
  "first amendment",
  "second amendment",
  "fourth amendment",
  "fifth amendment",
  "sixth amendment",
  "eighth amendment",
  "fourteenth amendment",
  "due process",
  "equal protection",
  "free speech",
  "religion clause",
  "establishment clause",
  "free exercise",
  "separation of powers",
  "federalism",
  "commerce clause",
  "takings clause",
  "sovereign immunity",
  "standing",
  "executive power",
  "congressional power",
];

export function constitutionalKeywordScore(article: Pick<NormalizedArticle, "originalTitle" | "cleanedText" | "rawText">) {
  const haystack = [article.originalTitle, article.cleanedText, article.rawText]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return CONSTITUTIONAL_KEYWORDS.reduce((score, keyword) => (haystack.includes(keyword) ? score + 1 : score), 0);
}

export function isConstitutionallyRelevant(article: NormalizedArticle) {
  return constitutionalKeywordScore(article) >= 1;
}
