import type { ArticleListItem } from "@/lib/db/types";

export function articleCaseNumber(article: Pick<ArticleListItem, "caseNumber" | "sourceMetadata">) {
  if (typeof article.caseNumber === "string" && article.caseNumber.trim()) return article.caseNumber.trim();
  const value = article.sourceMetadata?.caseNumber;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
