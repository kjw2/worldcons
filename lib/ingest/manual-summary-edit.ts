import { z } from "zod";
import { createEmbeddingArtifact } from "@/lib/ai/embeddings";
import { normalizeSummaryCandidate, SummarySchema } from "@/lib/ai/schema";
import { canonicalizeTerminologyValue } from "@/lib/ai/terminology";
import { articleLifecycleService } from "@/lib/article-lifecycle/service";
import { articlePublicationService } from "@/lib/article-publication/service";
import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import { runD1RefreshTagCounts, runD1SyncSummaryTags } from "@/lib/cloudflare/summary/d1-summary-drain";
import { recordAdminArticleEditHistory } from "@/lib/db/admin-audit";
import { ARTICLE_REVIEW_STATE } from "@/lib/db/article-triage";
import type { SummaryJson } from "@/lib/db/types";
import { ensureJudicialComplaintTags } from "@/lib/tags/judicial-complaint";
import { ARTICLE_LIFECYCLE_SUMMARY_ATTENTION_CODES } from "@/lib/article-lifecycle/compatibility";
import { tryPersistArticleEmbedding } from "@/lib/ingest/embedding-store";

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
  canonical_url?: string | null;
  cleaned_text?: string | null;
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
  const core = getRuntimeD1Binding("worldcons_core");
  if (!core) return { core: null, row: null };
  if (!articleId && !slug) return { core, row: null };
  const where = articleId ? "id=?" : "slug=?";
  const value = articleId ?? slug!;
  const result = await core.prepare(
    `SELECT id,slug,source_key,canonical_url,cleaned_text,status,korean_title,original_published_at,summarized_at,summary_json,source_metadata FROM articles WHERE ${where} LIMIT 1`,
  ).bind(value).all<Record<string, unknown>>();
  if (result.success === false || result.error) throw new Error(result.error || "manual_summary_edit.d1_read_failed");
  const raw = result.results?.[0];
  if (!raw) return { core, row: null };
  const parse = (value: unknown) => {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string" || !value.trim()) return null;
    try { return JSON.parse(value) as unknown; } catch { return null; }
  };
  return {
    core,
    row: {
      ...raw,
      summary_json: parse(raw.summary_json) as SummaryJson | null,
      source_metadata: parse(raw.source_metadata),
    } as ManualSummaryEditRow,
  };
}

export async function updateArticleSummaryManually(options: ManualSummaryEditOptions) {
  const { core, row } = await findArticle(options.articleId, options.slug);
  if (!core) {
    return { mode: "no-database" as const, status: "skipped" as const, reason: "worldcons_core D1 바인딩이 없어 상세내용을 저장할 수 없습니다." };
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

  const nextSummary = ensureJudicialComplaintTags(parsed.data.summary, {
    sourceKey: row.source_key,
    canonicalUrl: row.canonical_url,
    cleanedText: row.cleaned_text,
    sourceMetadata: row.source_metadata,
  });
  const fields = changedFields(row.summary_json, nextSummary);
  const hasSummaryChange = hasMeaningfulChange(row.summary_json, nextSummary);
  if (!hasSummaryChange && !parsed.data.note) {
    return { mode: "database" as const, status: "skipped" as const, reason: "변경된 내용이 없습니다." };
  }

  const embedding = hasSummaryChange ? await createEmbeddingArtifact(nextSummary).catch(() => null) : undefined;
  const sourceMetadata = reviewMetadata(row, parsed.data.note, fields, Boolean(embedding));
  const now = new Date().toISOString();
  const statement = hasSummaryChange
    ? core.prepare([
        "UPDATE articles SET korean_title=?,summary_json=?,summarized_at=?,source_metadata=?,error_metadata=NULL,",
        "embedding_provider=NULL,embedding_model=NULL,embedding_dimensions=NULL,embedding_input_hash=NULL,embedding_generated_at=NULL,updated_at=? WHERE id=?",
      ].join(" ")).bind(nextSummary.koreanTitle, JSON.stringify(nextSummary), now, JSON.stringify(sourceMetadata), now, row.id)
    : core.prepare("UPDATE articles SET korean_title=?,summary_json=?,summarized_at=?,source_metadata=?,error_metadata=NULL,updated_at=? WHERE id=?")
        .bind(nextSummary.koreanTitle, JSON.stringify(nextSummary), now, JSON.stringify(sourceMetadata), now, row.id);
  if (!statement.run) throw new Error("manual_summary_edit.d1_write_unavailable");
  const saved = await statement.run();
  if (saved.success === false || saved.error || Number(saved.meta?.changes ?? 0) !== 1) throw new Error(saved.error || "manual_summary_edit.d1_write_failed");
  await tryPersistArticleEmbedding(row.id, embedding);

  const lifecycle = await articleLifecycleService.get(row.id);
  if (lifecycle.ok) {
    await articleLifecycleService.transition({
      articleId: row.id,
      expectedRevision: lifecycle.data.revision,
      idempotencyKey: `admin-summary-edit:${row.id}:${lifecycle.data.revision}`,
      actorType: "admin",
      actorId: "admin",
      source: "admin.summary_edit",
      reasonCode: "review.summary_edited",
      processingState: "complete",
      reviewState: "approved",
      attention: { operation: "clear", resolvesCodes: [...ARTICLE_LIFECYCLE_SUMMARY_ATTENTION_CODES] },
    });
  }

  const publication = await articlePublicationService.getSnapshot(row.id);
  if (publication.ok) {
    await articlePublicationService.transition({
      articleId: row.id,
      expectedVersionRevision: publication.data.versionRevision,
      expectedPublicationRevision: publication.data.publicationRevision,
      expectedLegacyUpdatedAt: publication.data.legacyUpdatedAt,
      idempotencyKey: `admin-summary-edit-publication:${row.id}:${publication.data.publicationRevision}`,
      targetState: publication.data.publicationState ?? "draft",
      captureLegacy: true,
      actorType: "human",
      actorId: "admin",
      reason: "Manual summary edit persisted in Cloudflare D1.",
      provenanceActorType: "human",
      provenanceActorId: "admin",
      modelRef: nextSummary.aiMetadata?.model ?? null,
      safeMetadata: { changedFields: fields.slice(0, 40), notePresent: Boolean(parsed.data.note) },
    });
  }

  await recordAdminArticleEditHistory({
    articleId: row.id,
    articleSlug: row.slug,
    previousSummary: row.summary_json,
    nextSummary,
    changedFields: fields,
    note: parsed.data.note,
  });

  const tagSync = hasSummaryChange
    ? await runD1SyncSummaryTags(row.id, nextSummary, row.original_published_at, { replace: true })
    : { synced: false, upsertedTags: 0, removedArticleTags: 0 };
  const tagRefresh = hasSummaryChange ? await runD1RefreshTagCounts().catch((error) => ({ refreshed: false, errorMessage: error instanceof Error ? error.message : String(error) })) : undefined;

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
