import type { SummaryJson } from "@/lib/db/types";
import type { NormalizedArticle } from "@/lib/sources/types";
import { SummarySchema } from "@/lib/ai/schema";
import { completeJsonWithMetadata, type LlmCompletionResult } from "@/lib/ai/client";
import { buildRepairPrompt, buildSummaryUserPrompt, SUMMARY_SYSTEM_PROMPT } from "@/lib/ai/prompts";

export function mockSummary(article: NormalizedArticle): SummaryJson {
  return {
    koreanTitle: "요약 대기 중인 헌법재판 관련 게시물",
    originalTitle: article.originalTitle ?? "Original title",
    summary: {
      coreSummary: ["LLM API 키가 없어 개발용 대체 요약이 생성되었습니다."],
      referencedProvisions: [],
      background: "개발 환경용 대체 데이터입니다.",
      caseStructure: "원문 분석이 아직 수행되지 않았습니다.",
      implications: "실제 배포 환경에서는 LLM 요약으로 대체됩니다.",
      practicalNotes: "OPENAI_API_KEY를 설정한 뒤 다시 요약을 실행하세요.",
    },
    entities: [],
    tags: ["요약대기"],
    categories: ["development"],
    riskFlags: ["source_text_incomplete"],
    aiMetadata: {
      provider: "mock",
      model: "development-fallback",
      generatedAt: new Date().toISOString(),
    },
  };
}

function parseSummaryJson(raw: string) {
  const parsed = JSON.parse(raw) as unknown;
  return SummarySchema.parse(parsed);
}

function attachAiMetadata(summary: SummaryJson, completion: LlmCompletionResult): SummaryJson {
  return {
    ...summary,
    aiMetadata: {
      provider: completion.provider,
      model: completion.model,
      generatedAt: new Date().toISOString(),
    },
  };
}

export async function summarizeArticle(article: NormalizedArticle): Promise<SummaryJson> {
  const completion = await completeJsonWithMetadata([
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: buildSummaryUserPrompt(article) },
  ]);

  if (!completion) {
    if (process.env.ALLOW_MOCK_SUMMARY === "true") {
      return mockSummary(article);
    }

    throw new Error("No LLM completion available. Set a provider API key or ALLOW_MOCK_SUMMARY=true for local mock summaries.");
  }

  try {
    return attachAiMetadata(parseSummaryJson(completion.content), completion);
  } catch (error) {
    const repaired = await completeJsonWithMetadata([
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: buildRepairPrompt(completion.content) },
    ]);

    if (!repaired) {
      throw error;
    }

    return attachAiMetadata(parseSummaryJson(repaired.content), repaired);
  }
}
