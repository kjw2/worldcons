import { z } from "zod";
import { createEmbedding } from "@/lib/ai/embeddings";
import { normalizeSummaryCandidate, SummarySchema } from "@/lib/ai/schema";
import { canonicalizeTerminologyValue } from "@/lib/ai/terminology";
import { getSupabaseAdmin } from "@/lib/db/client";
import type { SummaryJson } from "@/lib/db/types";
import { runRefreshTagCounts } from "@/lib/ingest/summary";
import { syncSummaryTags } from "@/lib/ingest/summary-tags";

const MAX_NOTE_LENGTH = 1_000;
const MAX_TITLE_LENGTH = 500;
const MAX_SUMMARY_ITEM_LENGTH = 1_500;
const MAX_SUMMARY_TEXT_LENGTH = 8_000;
const MAX_TAGS = 80;
const MAX_ENTITIES = 80;
const MAX_PROVISIONS = 50;
const FORBIDDEN_SNAPSHOT_FIELD_MESSAGE = "원문 스냅샷 필드는 직접 수정할 수 없습니다.";
const FORBIDDEN_MANUAL_SUMMARY_EDIT_FIELDS = new Set([
  "raw_text",
  "rawText",
  "cleaned_text",
  "cleanedText",
  "original_url",
  "originalUrl",
  "canonical_url",
  "canonicalUrl",
  "content_hash",
  "contentHash",
  "source_text",
  "sourceText",
  "source_url",
  "sourceUrl",
  "source_snapshot",
  "sourceSnapshot",
  "raw_snapshot",
  "rawSnapshot",
  "extracted_text",
  "extractedText",
  "dedup_hash",
  "dedupHash",
]);

const ManualSummaryEditBodySchema = z.object({
  note: z.string().max(MAX_NOTE_LENGTH).optional(),
  summary: z.unknown(),
});

interface ManualSummaryEditRow {
  id: string;
  slug?: string | null;
  source_key: string;
  status: string;
  korean_title?: string | null;
  original_published_at?: string | null;
  summarized_at?: string | null;
  summary_json?: SummaryJson | null;
  source_metadata?: unknown;
}

interface ManualSummaryEditOptions {
  articleId?: string;
  slug?: string;
  body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmed(value?: string | null) {
  return value?.trim() ?? "";
}

function hasMeaningfulChange(previous: SummaryJson | null | undefined, next: SummaryJson) {
  return JSON.stringify(previous ?? null) !== JSON.stringify(next);
}

function changedFields(previous: SummaryJson | null | undefined, next: SummaryJson) {
  if (!previous) return ["summary_json"];

  const fields: string[] = [];
  if (previous.koreanTitle !== next.koreanTitle) fields.push("koreanTitle");
  if (JSON.stringify(previous.summary.coreSummary) !== JSON.stringify(next.summary.coreSummary)) fields.push("summary.coreSummary");
  if (JSON.stringify(previous.summary.referencedProvisions) !== JSON.stringify(next.summary.referencedProvisions)) fields.push("summary.referencedProvisions");
  if (previous.summary.background !== next.summary.background) fields.push("summary.background");
  if (previous.summary.caseStructure !== next.summary.caseStructure) fields.push("summary.caseStructure");
  if (previous.summary.implications !== next.summary.implications) fields.push("summary.implications");
  if (previous.summary.practicalNotes !== next.summary.practicalNotes) fields.push("summary.practicalNotes");
  if (JSON.stringify(previous.entities) !== JSON.stringify(next.entities)) fields.push("entities");
  if (JSON.stringify(previous.tags) !== JSON.stringify(next.tags)) fields.push("tags");
  if (JSON.stringify(previous.categories) !== JSON.stringify(next.categories)) fields.push("categories");
  if (JSON.stringify(previous.riskFlags) !== JSON.stringify(next.riskFlags)) fields.push("riskFlags");
  return fields;
}

function validateManualSummary(summary: SummaryJson) {
  if (!trimmed(summary.koreanTitle)) return "한국어 제목은 비울 수 없습니다.";
  if (summary.koreanTitle.length > MAX_TITLE_LENGTH) return `한국어 제목은 ${MAX_TITLE_LENGTH}자 이하로 입력해야 합니다.`;
  if (summary.summary.coreSummary.length === 0) return "핵심 요약은 최소 1개가 필요합니다.";
  if (summary.summary.coreSummary.some((item) => !trimmed(item))) return "핵심 요약에는 빈 항목을 둘 수 없습니다.";
  if (summary.summary.coreSummary.some((item) => item.length > MAX_SUMMARY_ITEM_LENGTH)) {
    return `핵심 요약 각 항목은 ${MAX_SUMMARY_ITEM_LENGTH}자 이하로 입력해야 합니다.`;
  }

  const bodyFields = [summary.summary.background, summary.summary.caseStructure, summary.summary.implications, summary.summary.practicalNotes];
  if (bodyFields.some((item) => item.length > MAX_SUMMARY_TEXT_LENGTH)) {
    return `요약 본문 각 항목은 ${MAX_SUMMARY_TEXT_LENGTH}자 이하로 입력해야 합니다.`;
  }
  if (summary.summary.referencedProvisions.length > MAX_PROVISIONS) return `참조 조문은 ${MAX_PROVISIONS}개 이하로 입력해야 합니다.`;
  if (summary.tags.length > MAX_TAGS) return `태그는 ${MAX_TAGS}개 이하로 입력해야 합니다.`;
  if (summary.categories.length > MAX_TAGS) return `카테고리는 ${MAX_TAGS}개 이하로 입력해야 합니다.`;
  if (summary.entities.length > MAX_ENTITIES) return `엔티티는 ${MAX_ENTITIES}개 이하로 입력해야 합니다.`;
  return null;
}

function forbiddenManualSummaryEditFields(body: unknown) {
  if (!isRecord(body)) return [];
  return Object.keys(body).filter((key) => FORBIDDEN_MANUAL_SUMMARY_EDIT_FIELDS.has(key));
}

export function parseManualSummaryEditInput(body: unknown, sourceKey?: string | null) {
  const forbiddenFields = forbiddenManualSummaryEditFields(body);
  if (forbiddenFields.length > 0) {
    return { ok: false as const, error: `${FORBIDDEN_SNAPSHOT_FIELD_MESSAGE} (${forbiddenFields.join(", ")})` };
  }

  const parsedBody = ManualSummaryEditBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return { ok: false as const, error: "요약 수정 요청 형식이 올바르지 않습니다." };
  }

  const parsedSummary = SummarySchema.safeParse(normalizeSummaryCandidate(parsedBody.data.summary));
  if (!parsedSummary.success) {
    return { ok: false as const, error: "요약 JSON 구조가 올바르지 않습니다." };
  }

  const summary = canonicalizeTerminologyValue(parsedSummary.data as SummaryJson, sourceKey);
  const validationError = validateManualSummary(summary);
  if (validationError) {
    return { ok: false as const, error: validationError };
  }

  return {
    ok: true as const,
    data: {
      note: parsedBody.data.note?.trim() || undefined,
      summary,
    },
  };
}

function reviewMetadata(row: ManualSummaryEditRow, note: string | undefined, fields: string[], embeddingUpdated: boolean) {
  const metadata = isRecord(row.source_metadata) ? row.source_metadata : {};
  const collection = isRecord(metadata.collection) ? metadata.collection : {};
  const reviewHistory = Array.isArray(metadata.reviewHistory) ? metadata.reviewHistory : [];
  const reviewedAt = new Date().toISOString();
  const review = {
    decision: "manual_summary_edit",
    note,
    reviewedAt,
    previousStatus: row.status,
    changedFields: fields,
    embeddingUpdated,
  };

  return {
    ...metadata,
    collection,
    review,
    reviewHistory: [...reviewHistory.slice(-19), review],
  };
}

async function findArticle(articleId?: string, slug?: string) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { supabase: null, row: null };
  if (!articleId && !slug) return { supabase, row: null };

  let query = supabase
    .from("articles")
    .select("id, slug, source_key, status, korean_title, original_published_at, summarized_at, summary_json, source_metadata");
  query = articleId ? query.eq("id", articleId) : query.eq("slug", slug);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return { supabase, row: data ? (data as ManualSummaryEditRow) : null };
}

export async function updateArticleSummaryManually(options: ManualSummaryEditOptions) {
  const { supabase, row } = await findArticle(options.articleId, options.slug);
  if (!supabase) {
    return { mode: "no-database" as const, status: "skipped" as const, reason: "Supabase 환경변수가 없어 상세내용을 저장할 수 없습니다." };
  }
  if (!row) {
    return { mode: "database" as const, status: "not_found" as const, reason: "자료를 찾을 수 없습니다." };
  }
  if (!row.summary_json) {
    return { mode: "database" as const, status: "skipped" as const, reason: "수정할 요약이 없습니다. 먼저 요약을 생성해야 합니다." };
  }

  const parsed = parseManualSummaryEditInput(options.body, row.source_key);
  if (!parsed.ok) {
    return { mode: "database" as const, status: "invalid" as const, reason: parsed.error };
  }

  const fields = changedFields(row.summary_json, parsed.data.summary);
  const hasSummaryChange = hasMeaningfulChange(row.summary_json, parsed.data.summary);
  if (!hasSummaryChange && !parsed.data.note) {
    return { mode: "database" as const, status: "skipped" as const, reason: "변경된 내용이 없습니다." };
  }

  const embedding = hasSummaryChange ? await createEmbedding(parsed.data.summary).catch(() => null) : undefined;
  const sourceMetadata = reviewMetadata(row, parsed.data.note, fields, Boolean(embedding));
  const updatePayload: Record<string, unknown> = {
    korean_title: parsed.data.summary.koreanTitle,
    summary_json: parsed.data.summary,
    summarized_at: new Date().toISOString(),
    source_metadata: sourceMetadata,
    error_metadata: null,
  };
  if (hasSummaryChange) {
    updatePayload.embedding = embedding ?? null;
  }

  const { error: updateError } = await supabase.from("articles").update(updatePayload).eq("id", row.id);
  if (updateError) throw new Error(updateError.message);

  const tagSync = hasSummaryChange
    ? await syncSummaryTags(row.id, parsed.data.summary, row.original_published_at, { replace: true })
    : { synced: false, upsertedTags: 0, removedArticleTags: 0 };
  const tagRefresh = hasSummaryChange ? await runRefreshTagCounts().catch((error) => ({ refreshed: false, errorMessage: error instanceof Error ? error.message : String(error) })) : undefined;

  return {
    mode: "database" as const,
    status: "updated" as const,
    articleId: row.id,
    slug: row.slug,
    changedFields: fields,
    tagSync,
    tagRefresh,
    embeddingUpdated: Boolean(embedding),
    embeddingCleared: hasSummaryChange && !embedding,
  };
}
