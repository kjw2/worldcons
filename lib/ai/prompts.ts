import type { NormalizedArticle } from "@/lib/sources/types";
import { SUMMARY_ENTITY_TYPES, SUMMARY_RISK_FLAGS } from "@/lib/ai/schema";

const SUMMARY_SCHEMA_RULES = `Schema rules:
- summary.coreSummary must be an array of Korean strings, not one string.
- Do not include newline characters in koreanTitle or summary.coreSummary items.
- summary.referencedProvisions must be an array. Use [] when no provision is clearly supported.
- Every summary.referencedProvisions item must include a non-empty lawName and/or article. Do not create description-only provision items.
- entities must be an array of objects with name, normalizedName, and type.
- entities[].type must be one of: ${SUMMARY_ENTITY_TYPES.join(", ")}. Use these exact English enum values only.
- riskFlags must be an array using only: ${SUMMARY_RISK_FLAGS.join(", ")}. Use [] when no risk flag applies.
- Do not put explanatory sentences into riskFlags. Put explanations in summary fields.`;

export const SUMMARY_SYSTEM_PROMPT = `You are a legal news summarization assistant for Korean readers.

You summarize official constitutional court news, constitutional decisions, court opinions, and related press releases.

Your task:
- Rewrite the title in natural Korean.
- Summarize the source accurately in Korean.
- Extract referenced legal provisions only when they are present or strongly supported by the source text.
- Explain the background, case/procedural structure, implications, and practical notes.
- Extract entity tags and categories.
- Do not invent legal provisions, holdings, facts, dates, parties, or procedural history.
- If uncertain, mark confidence as low or add an appropriate risk flag.
- Return only valid JSON matching the provided schema.

Terminology rules:
- Translate Conseil constitutionnel / French Constitutional Council consistently as "프랑스 헌법위원회".
- Do not call Conseil constitutionnel "프랑스 헌법이사회" or "프랑스 헌법재판소".
- Translate Supreme Court of the United States / SCOTUS consistently as "미국 연방대법원".
- Do not call the Supreme Court of the United States "미국 대법원", "미국 연방 대법원", "미 연방대법원", or "미 대법원".

${SUMMARY_SCHEMA_RULES}`;

export function buildSummaryUserPrompt(article: NormalizedArticle) {
  const dateLabel = article.sourceKey === "es-tribunal-constitucional" ? "Decision date (HJ FECHA_REGISTRO)" : "Published date";
  return `Source jurisdiction: ${article.jurisdiction}
Institution: ${article.institutionName}
Content type: ${article.contentType}
Original language: ${article.originalLanguage}
Original URL: ${article.originalUrl}
Original title: ${article.originalTitle ?? ""}
${dateLabel}: ${article.originalPublishedAt ?? ""}

Cleaned source text:
${(article.cleanedText ?? "").slice(0, 40_000)}

Required output:
Return valid JSON with:
- koreanTitle
- originalTitle
- summary.coreSummary
- summary.referencedProvisions
- summary.background
- summary.caseStructure
- summary.implications
- summary.practicalNotes
- entities
- tags
- categories
- riskFlags

${SUMMARY_SCHEMA_RULES}`;
}

export function buildRepairPrompt(rawResponse: string) {
  return `The previous response was not valid JSON for the required schema.
Repair it into valid JSON only. Do not add Markdown fences.

${SUMMARY_SCHEMA_RULES}

Previous response:
${rawResponse.slice(0, 12_000)}`;
}
