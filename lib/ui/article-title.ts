import type { ArticleListItem } from "@/lib/db/types";
import { articleCaseNumber } from "@/lib/ui/article-case-number";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function caseNumberAnchor(caseNumber: string) {
  const match = caseNumber.match(/^(\d{2,4}[-/]\d+)/);
  return match ? `${escapeRegExp(match[1])}(?:[-/]\\d+)*` : escapeRegExp(caseNumber);
}

function cleanTitleSpacing(title: string) {
  return title
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,:;])/g, "$1")
    .replace(/([,:;])\s*:/g, "$1")
    .replace(/\s+([.!?])/g, "$1")
    .trim();
}

/**
 * Removes a docket number that older summaries sometimes embedded in the
 * Korean title, so the canonical metadata can be rendered once as a suffix.
 */
export function articleTitleForDisplay(
  article: Pick<ArticleListItem, "koreanTitle" | "originalTitle" | "caseNumber" | "sourceMetadata">,
) {
  const title = article.koreanTitle || article.originalTitle || "제목 미상";
  const caseNumber = articleCaseNumber(article);
  if (!caseNumber) return title;

  const anchor = caseNumberAnchor(caseNumber);
  const exact = escapeRegExp(caseNumber);
  let cleaned = title;

  // Strip parenthetical docket/date phrases wherever they occur in a title.
  cleaned = cleaned.replace(new RegExp(`\\s*\\([^()]{0,240}(?:${anchor}|${exact})[^()]{0,240}\\)`, "giu"), "");

  // Strip inline forms such as "결정 제2026-913 DC호" or "판결 57/2026".
  cleaned = cleaned.replace(
    new RegExp(`(?:결정(?:번호|\\s*제)?|판결(?:\\s*제)?|제)?\\s*(?:${anchor}|${exact})(?:\\s+[A-Z]{1,8}){0,3}호?`, "giu"),
    "",
  );

  return cleanTitleSpacing(cleaned);
}
