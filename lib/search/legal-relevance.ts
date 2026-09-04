import type { ArticleListItem } from "@/lib/db/types";

const SEARCH_INTENT_NOISE = new Set([
  "관련",
  "관련된",
  "관한",
  "대한",
  "대해",
  "판례",
  "판례를",
  "결정",
  "결정을",
  "검색",
  "찾아줘",
  "찾아주세요",
  "알려줘",
  "알려주세요"
]);

export function normalizeLegalSearchQuery(query?: string | null): string {
  const normalized = query?.normalize("NFKC").replace(/\s+/gu, " ").trim() ?? "";
  if (!normalized) return "";
  const tokens = normalized.split(" ").filter(Boolean);
  const meaningful = tokens.filter((token) => !SEARCH_INTENT_NOISE.has(token.toLocaleLowerCase("ko-KR")));
  return (meaningful.length > 0 ? meaningful : tokens).join(" ");
}

export function rerankLegalSearchItems(
  query: string,
  items: readonly ArticleListItem[]
): ArticleListItem[] {
  const normalizedQuery = normalizeLegalSearchQuery(query);
  if (!normalizedQuery || items.length < 2) return [...items];

  return items
    .map((item, index) => ({ item, index, score: legalSearchRelevanceScore(normalizedQuery, item) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.item);
}

export function legalSearchRelevanceScore(query: string, item: ArticleListItem): number {
  const normalizedQuery = normalizeLegalSearchQuery(query);
  if (!normalizedQuery) return 0;
  const queryCompact = compactSearchText(normalizedQuery);
  const queryTerms = searchTerms(normalizedQuery);
  const titles = [item.koreanTitle, item.originalTitle].filter((value): value is string => Boolean(value));
  const compactTitles = titles.map(compactSearchText).filter(Boolean);
  const titleHaystack = compactTitles.join(" ");
  const caseNumber = compactSearchText(item.caseNumber ?? "");
  const summaryText = [
    item.oneLineSummary,
    ...(item.summaryJson?.summary.coreSummary ?? []),
    item.summaryJson?.summary.background,
    item.summaryJson?.summary.caseStructure,
    item.summaryJson?.summary.implications,
    ...(item.summaryJson?.summary.referencedProvisions ?? []).flatMap((provision) => [
      provision.lawName,
      provision.article,
      provision.description
    ]),
    ...(item.tags ?? []).flatMap((tag) => [tag.name, tag.normalizedName])
  ]
    .filter((value): value is string => Boolean(value))
    .map(compactSearchText)
    .join(" ");

  let score = 0;
  if (caseNumber && queryCompact.includes(caseNumber)) score += 1_000;
  if (compactTitles.some((title) => title === queryCompact)) score += 500;
  if (queryCompact.length >= 3 && compactTitles.some((title) => title.includes(queryCompact))) score += 180;

  const titleMatches = queryTerms.filter((term) => titleHaystack.includes(term)).length;
  const summaryMatches = queryTerms.filter((term) => summaryText.includes(term)).length;
  if (queryTerms.length > 0 && titleMatches === queryTerms.length) score += 120;
  score += titleMatches * 24;
  score += summaryMatches * 6;

  return score;
}

function searchTerms(value: string): string[] {
  return Array.from(
    new Set(
      Array.from(value.matchAll(/[\p{L}\p{N}_]+/gu))
        .map((match) => compactSearchText(match[0]))
        .filter((term) => term.length >= 2)
    )
  ).slice(0, 8);
}

function compactSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[^\p{L}\p{N}_]+/gu, "");
}
