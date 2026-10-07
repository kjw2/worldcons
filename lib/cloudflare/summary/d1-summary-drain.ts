import type { SummaryJson, ArticleContentType } from "@/lib/db/types";
import type { D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import { summarizeArticle } from "@/lib/ai/summarize";
import { createEmbeddingArtifact } from "@/lib/ai/embeddings";
import { tryPersistArticleEmbedding } from "@/lib/ingest/embedding-store";
import { canSummarizeArticle, MIN_PUBLISHABLE_TEXT_LENGTH } from "@/lib/ingest/publishability";
import { orderSummaryCandidatesRoundRobin, isGlobalSummaryBackoff, summaryRetryDelayMs } from "@/lib/ingest/summary-batch";
import { normalizeTagForStorage } from "@/lib/ai/tags";
import { glossaryCoveredTagKeys, tagAliasKey } from "@/lib/glossary/tag-aliases";
import type { GlossaryTerm, TagType } from "@/lib/db/types";
import { classifySummaryError, ARTICLE_ERROR_CLASS, ARTICLE_REVIEW_STATE } from "@/lib/db/article-triage";
import { ARTICLE_LIFECYCLE_SUMMARY_ATTENTION_CODES } from "@/lib/article-lifecycle/compatibility";
import { articleLifecycleService } from "@/lib/article-lifecycle/service";
import { boundedInteger } from "@/lib/utils/numbers";
import type { ArticleLifecycleTransitionInput } from "@/lib/article-lifecycle/types";

interface SummaryCandidateRow {
  id: string;
  slug: string;
  source_key: string;
  jurisdiction: string;
  institution_name: string;
  content_type: ArticleContentType;
  original_url: string;
  canonical_url: string;
  original_language: string;
  original_title: string | null;
  original_published_at: string | null;
  cleaned_text: string | null;
  summary_json: string | null;
  status: string;
  source_metadata: unknown;
  error_class: string | null;
  error_context: unknown;
  review_state: string | null;
  created_at: string;
  updated_at: string;
  translation_status?: string | null;
}

function ensureSuccess<T>(result: { success?: boolean; error?: string | null; results?: T[] }) {
  if (result.success === false || result.error) throw new Error("summary_d1.query_failed");
  return result.results ?? [];
}

function statementRun(statement: D1RuntimePreparedStatement) {
  if (!statement.run) throw new Error("summary_d1.write_unavailable");
  return statement.run();
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return value && typeof value === "object" ? value as Record<string, unknown> : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeSourceMetadata(value: unknown) {
  const source = parseJson(value);
  if (Object.keys(parseJson(source.collection)).length > 0) return source;
  const nestedCase = parseJson(source.case);
  const nestedCollection = parseJson(nestedCase.collection);
  if (Object.keys(nestedCollection).length === 0) return source;
  return { ...nestedCase, ...source, collection: nestedCollection };
}

function sourceCollection(value: unknown) {
  const source = normalizeSourceMetadata(value);
  return parseJson(source.collection);
}

function ingestionRunIdFromSourceMetadata(value: unknown) {
  const id = sourceCollection(value).diagnosticsId;
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)
    ? id
    : undefined;
}

function staleMinutes() {
  const parsed = Number(process.env.STALE_SUMMARIZING_MINUTES ?? 30);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

function d1(core = getRuntimeD1Binding("worldcons_core")) {
  if (!core) throw new Error("summary_d1.core_binding_missing");
  return core;
}

function transitionKey(articleId: string, operation: string, revision: number) {
  return `summary:${operation}:${articleId}:${revision}`;
}

async function lifecycle(articleId: string, input: Omit<ArticleLifecycleTransitionInput, "articleId" | "expectedRevision" | "idempotencyKey" | "actorType" | "actorId">) {
  const current = await articleLifecycleService.get(articleId);
  if (!current.ok) throw new Error(`summary_lifecycle_read:${current.error.code}`);
  // Backfill-staged articles created before the translation/publication split can
  // legitimately have no P2 lifecycle axes yet. Summary work is only selected
  // for source-text-ready rows, so hydrate the missing axes on first transition
  // instead of attempting an incomplete processing-only transition.
  const hydratedInput = {
    ...input,
    ...(current.data.collectionState === null && input.collectionState === undefined
      ? { collectionState: "source_text_ready" as const }
      : {}),
    ...(current.data.processingState === null && input.processingState === undefined
      ? { processingState: "ready" as const }
      : {}),
    ...(current.data.reviewState === null && input.reviewState === undefined
      ? { reviewState: "unreviewed" as const }
      : {}),
  };
  const result = await articleLifecycleService.transition({
    ...hydratedInput,
    articleId,
    expectedRevision: current.data.revision,
    idempotencyKey: transitionKey(articleId, input.reasonCode, current.data.revision),
    actorType: "summary_worker",
    actorId: "m8-summary-drain",
  });
  if (!result.ok) throw new Error(`summary_lifecycle_transition:${result.error.code}`);
  return result.data;
}

async function recoverStaleSummarizing(options: { limit: number; sourceKey?: string }, now = Date.now()) {
  const core = d1();
  const cutoff = new Date(now - staleMinutes() * 60_000).toISOString();
  const sourceFilter = options.sourceKey ? " AND source_key = ?" : "";
  const rows = ensureSuccess(await core.prepare(
    `SELECT id FROM articles WHERE status='summarizing' AND updated_at < ?${sourceFilter} ORDER BY updated_at ASC, id ASC LIMIT ?`,
  ).bind(...(options.sourceKey ? [cutoff, options.sourceKey, options.limit] : [cutoff, options.limit])).all<{ id: string }>()).map((row) => row.id);
  if (rows.length === 0) return { mode: "database" as const, recoveredCount: 0, cutoff };
  const nowIso = new Date(now).toISOString();
  const statements = rows.map((id) => core.prepare(
    "UPDATE articles SET status='failed_summary',translation_status='pending',translation_error_code='job.stale_running',translation_error_summary=?,translation_next_attempt_at=?, error_metadata=?, error_class=?, error_context=?, review_state=?, updated_at=? WHERE id=? AND status='summarizing' AND updated_at < ?",
  ).bind(
    `Stale translation/enrichment state recovered after ${staleMinutes()} minutes.`,
    nowIso,
    JSON.stringify({ message: `Stale summarizing state recovered after ${staleMinutes()} minutes.` }),
    ARTICLE_ERROR_CLASS.JOB_STALE_RUNNING,
    JSON.stringify({ message: `Stale summarizing state recovered after ${staleMinutes()} minutes.` }),
    ARTICLE_REVIEW_STATE.NEEDS_TRIAGE,
    nowIso,
    id,
    cutoff,
  ));
  const results = core.batch ? await core.batch(statements) : await Promise.all(statements.map(statementRun));
  if (Array.isArray(results) && results.some((result) => result.success === false || result.error)) throw new Error("summary_d1.recovery_write_failed");
  for (const id of rows) {
    await lifecycle(id, {
      source: "summary.recovery",
      reasonCode: "legacy.summary.stale_recovered",
      processingState: "ready",
      reviewState: "needs_review",
      attention: { operation: "raise", code: "job.stale_running", retryable: true, severity: "high", source: "processing" },
    });
  }
  return { mode: "database" as const, recoveredCount: rows.length, cutoff };
}

async function selectCandidates(options: { limit: number; sourceKey?: string; fetchLimit: number }) {
  const sourceFilter = options.sourceKey ? " AND source_key = ?" : "";
  const rows = ensureSuccess(await d1().prepare(
    `SELECT id,slug,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,original_published_at,cleaned_text,summary_json,status,source_metadata,error_class,error_context,review_state,created_at,updated_at,translation_status FROM articles WHERE status IN ('cleaned','failed_summary') AND summarized_at IS NULL AND translation_status IN ('pending','failed') AND (translation_next_attempt_at IS NULL OR translation_next_attempt_at<=?) AND json_valid(source_metadata) AND COALESCE(json_extract(source_metadata,'$.collection.publishable'),json_extract(source_metadata,'$.case.collection.publishable'))=1${sourceFilter} ORDER BY CASE WHEN COALESCE(json_extract(source_metadata,'$.catalog.sourceOnly'),0)=1 THEN 1 ELSE 0 END ASC,created_at ASC,id ASC LIMIT ?`,
  ).bind(...(options.sourceKey ? [new Date().toISOString(), options.sourceKey, options.fetchLimit] : [new Date().toISOString(), options.fetchLimit])).all<SummaryCandidateRow>());
  return orderSummaryCandidatesRoundRobin(rows);
}

async function syncTags(articleId: string, summary: SummaryJson, originalPublishedAt: string | null, replace = true) {
  const core = d1();
  const inputs = [
    ...summary.entities.map((entity) => ({ name: entity.name, normalizedName: entity.normalizedName, type: entity.type })),
    ...summary.tags.map((name) => ({ name, normalizedName: name, type: "topic" as const })),
  ];
  const seen = new Set<string>();
  const unique = inputs.map((input) => normalizeTagForStorage(input.name, input.normalizedName, input.type)).filter((tag) => {
    if (seen.has(tag.slug)) return false;
    seen.add(tag.slug);
    return true;
  });
  const now = new Date().toISOString();
  const desiredIds: string[] = [];
  for (const tag of unique) {
    const result = await core.prepare(
      "INSERT INTO tags (id,slug,name,normalized_name,type,article_count,latest_article_at,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?,?) ON CONFLICT(slug) DO UPDATE SET name=excluded.name,normalized_name=excluded.normalized_name,type=excluded.type,latest_article_at=excluded.latest_article_at,updated_at=excluded.updated_at RETURNING id",
    ).bind(crypto.randomUUID(), tag.slug, tag.name, tag.normalizedName, tag.type, originalPublishedAt, now, now).all<{ id: string }>();
    desiredIds.push(...ensureSuccess(result).map((row) => row.id));
  }
  const statements = desiredIds.map((tagId) => core.prepare(
    "INSERT INTO article_tags (article_id,tag_id,confidence,created_at) VALUES (?,?,0.8,?) ON CONFLICT(article_id,tag_id) DO UPDATE SET confidence=excluded.confidence",
  ).bind(articleId, tagId, now));
  if (replace) {
    const exclusion = desiredIds.length ? `AND tag_id NOT IN (${desiredIds.map(() => "?").join(",")})` : "";
    statements.push(core.prepare(`DELETE FROM article_tags WHERE article_id=? ${exclusion}`).bind(articleId, ...desiredIds));
  }
  if (statements.length) {
    if (!core.batch) throw new Error("summary_d1.batch_unavailable");
    const results = await core.batch(statements);
    if (results.some((result) => result.success === false || result.error)) throw new Error("summary_d1.tag_write_failed");
  }
  return { upsertedTags: desiredIds.length };
}

export async function runD1SyncSummaryTags(
  articleId: string,
  summary: SummaryJson,
  originalPublishedAt?: string | null,
  options: { replace?: boolean } = {},
) {
  return syncTags(articleId, summary, originalPublishedAt ?? null, options.replace !== false);
}

async function refreshTagCounts() {
  const core = d1();
  const result = await statementRun(core.prepare(`
    UPDATE tags SET
      article_count=(SELECT COUNT(*) FROM article_tags at JOIN articles a ON a.id=at.article_id WHERE at.tag_id=tags.id AND a.status='summarized' AND json_valid(a.source_metadata) AND json_extract(a.source_metadata,'$.collection.publishable')=1),
      latest_article_at=(SELECT MAX(a.original_published_at) FROM article_tags at JOIN articles a ON a.id=at.article_id WHERE at.tag_id=tags.id AND a.status='summarized' AND json_valid(a.source_metadata) AND json_extract(a.source_metadata,'$.collection.publishable')=1),
      updated_at=?
    WHERE article_count IS NOT (SELECT COUNT(*) FROM article_tags at JOIN articles a ON a.id=at.article_id WHERE at.tag_id=tags.id AND a.status='summarized' AND json_valid(a.source_metadata) AND json_extract(a.source_metadata,'$.collection.publishable')=1)
       OR latest_article_at IS NOT (SELECT MAX(a.original_published_at) FROM article_tags at JOIN articles a ON a.id=at.article_id WHERE at.tag_id=tags.id AND a.status='summarized' AND json_valid(a.source_metadata) AND json_extract(a.source_metadata,'$.collection.publishable')=1)
  `).bind(new Date().toISOString()));
  if (result.success === false || result.error) throw new Error("summary_d1.tag_count_refresh_failed");
  const minCount = boundedInteger(process.env.GLOSSARY_CANDIDATE_MIN_COUNT, 5, { min: 1, max: 1000 });
  const limit = boundedInteger(process.env.GLOSSARY_CANDIDATE_LIMIT, 50, { min: 1, max: 500 });
  const [termsResult, existingResult, tagsResult] = await Promise.all([
    core.prepare("SELECT slug,term,korean_term,related_tags FROM glossary_terms").all<{ slug: string; term: string; korean_term: string | null; related_tags: string | null }>(),
    core.prepare("SELECT tag_slug,status FROM glossary_candidates").all<{ tag_slug: string; status: string }>(),
    core.prepare("SELECT id,slug,name,type,article_count FROM tags WHERE article_count>=? ORDER BY article_count DESC LIMIT ?").bind(minCount, limit * 4).all<{ id: string; slug: string; name: string; type: string; article_count: number }>(),
  ]);
  const terms: GlossaryTerm[] = ensureSuccess(termsResult).map((term) => ({
    slug: term.slug,
    term: term.term,
    koreanTerm: term.korean_term,
    definition: "",
    relatedTags: (() => { try { const parsed: unknown = JSON.parse(term.related_tags ?? "[]"); return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : []; } catch { return []; } })(),
  }));
  const covered = glossaryCoveredTagKeys(terms);
  const terminal = new Set(ensureSuccess(existingResult).filter((row) => row.status === "approved" || row.status === "ignored").map((row) => row.tag_slug));
  const candidateTags = ensureSuccess(tagsResult);
  const candidateTypes = new Set<TagType>(["article", "right", "topic", "doctrine", "procedure", "law", "case_type"]);
  const seen = new Set<string>();
  const candidates = [] as Array<{ slug: string; name: string; type: string; count: number; languages: string[] }>;
  for (const tag of candidateTags) {
    if (!candidateTypes.has(tag.type as TagType) || terminal.has(tag.slug) || covered.has(tagAliasKey(tag.name)) || seen.has(tagAliasKey(tag.name))) continue;
    const languagesResult = await core.prepare(
      "SELECT a.original_language,COUNT(*) AS count FROM article_tags at JOIN articles a ON a.id=at.article_id WHERE at.tag_id=? GROUP BY a.original_language ORDER BY count DESC LIMIT 30",
    ).bind(tag.id).all<{ original_language: string; count: number }>();
    candidates.push({ slug: tag.slug, name: tag.name, type: tag.type, count: tag.article_count, languages: ensureSuccess(languagesResult).map((row) => row.original_language) });
    seen.add(tagAliasKey(tag.name));
    if (candidates.length >= limit) break;
  }
  if (candidates.length > 0) {
    const now = new Date().toISOString();
    const statements = candidates.map((candidate) => {
      const suggestedSlug = normalizeTagForStorage(candidate.name).slug;
      return core.prepare(
        "INSERT INTO glossary_candidates (id,tag_slug,tag_name,tag_type,article_count,suggested_slug,source_languages,status,generated_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',?,?,?) ON CONFLICT(tag_slug) DO UPDATE SET tag_name=excluded.tag_name,tag_type=excluded.tag_type,article_count=excluded.article_count,suggested_slug=excluded.suggested_slug,source_languages=excluded.source_languages,generated_at=excluded.generated_at,updated_at=excluded.updated_at WHERE glossary_candidates.status='pending'",
      ).bind(crypto.randomUUID(), candidate.slug, candidate.name, candidate.type, candidate.count, suggestedSlug, JSON.stringify(candidate.languages), now, now, now);
    });
    if (!core.batch) throw new Error("summary_d1.batch_unavailable");
    const writes = await core.batch(statements);
    if (writes.some((write) => write.success === false || write.error)) throw new Error("summary_d1.glossary_candidate_write_failed");
  }
  return { refreshed: true, updatedTags: Number(result.meta?.changes ?? 0), glossaryCandidates: candidates.length };
}

export async function runD1RefreshTagCounts() {
  return refreshTagCounts();
}

export async function runD1SummarizeArticle(input: {
  articleId?: string;
  slug?: string;
  apiKeys: string[];
  model?: string;
  summarize?: typeof summarizeArticle;
  createEmbedding?: typeof createEmbeddingArtifact;
}) {
  const articleId = input.articleId?.trim();
  const slug = input.slug?.trim();
  if (!articleId && !slug) throw new Error("summary_d1.article_identifier_required");
  const core = d1();
  const where = articleId ? "id = ?" : "slug = ?";
  const value = articleId ?? slug!;
  const rows = ensureSuccess(await core.prepare(
    `SELECT id,slug,source_key,jurisdiction,institution_name,content_type,original_url,canonical_url,original_language,original_title,original_published_at,cleaned_text,summary_json,status,source_metadata,error_class,error_context,review_state,created_at,updated_at,translation_status FROM articles WHERE ${where} LIMIT 1`,
  ).bind(value).all<SummaryCandidateRow>());
  const row = rows[0];
  if (!row) throw new Error("summary_d1.article_not_found");
  const keys = input.apiKeys.map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0) throw new Error("summary_d1.api_key_missing");
  const result = await summarizeCandidate(row, {
    apiKeys: keys,
    model: input.model,
    summarize: input.summarize,
    createEmbedding: input.createEmbedding,
  });
  if (result.status === "failed") throw new Error(result.errorMessage);
  const runId = ingestionRunIdFromSourceMetadata(row.source_metadata);
  const ingestionRunSummaryCounts = runId ? await syncIngestionRunCounts([runId]) : {};
  const tagRefresh = result.status === "summarized" ? await refreshTagCounts() : undefined;
  return { mode: "database" as const, articleId: row.id, slug: row.slug, result, ingestionRunSummaryCounts, tagRefresh };
}

async function syncIngestionRunCounts(runIds: Iterable<string>) {
  const core = d1();
  const ingest = getRuntimeD1Binding("worldcons_ingest");
  if (!ingest) throw new Error("summary_d1.ingest_binding_missing");
  const counts: Record<string, number> = {};
  for (const id of new Set(runIds)) {
    const countResult = ensureSuccess(await core.prepare(
      "SELECT COUNT(*) AS count FROM articles WHERE status='summarized' AND json_valid(source_metadata) AND json_extract(source_metadata,'$.collection.diagnosticsId')=?",
    ).bind(id).all<{ count: number }>());
    const count = Number(countResult[0]?.count ?? 0);
    const update = await statementRun(ingest.prepare("UPDATE ingestion_runs SET summarized_count=? WHERE id=?").bind(count, id));
    if (update.success === false || update.error || Number(update.meta?.changes ?? 0) !== 1) throw new Error("summary_d1.ingestion_run_sync_failed");
    counts[id] = count;
  }
  return counts;
}

async function summarizeCandidate(row: SummaryCandidateRow, options: { apiKeys: string[]; model?: string; summarize?: typeof summarizeArticle; createEmbedding?: typeof createEmbeddingArtifact }) {
  const sourceMetadata = normalizeSourceMetadata(row.source_metadata);
  const collection = sourceCollection(sourceMetadata);
  const forceAllowed = row.status === "summarized"
    && typeof row.cleaned_text === "string"
    && row.cleaned_text.trim().length >= MIN_PUBLISHABLE_TEXT_LENGTH
    && collection.publishable === true;
  if (!canSummarizeArticle({ ...row, source_metadata: sourceMetadata }) && !forceAllowed) {
    return { status: "skipped" as const, reason: "Article is not eligible for summarization." };
  }
  const core = d1();
  const started = await statementRun(core.prepare(
    "UPDATE articles SET status=CASE WHEN ? THEN status ELSE 'summarizing' END,translation_status=CASE WHEN ? THEN translation_status ELSE 'running' END,translation_started_at=CASE WHEN ? THEN translation_started_at ELSE ? END,translation_attempt_count=translation_attempt_count+CASE WHEN ? THEN 0 ELSE 1 END,translation_error_code=NULL,translation_error_summary=NULL,translation_next_attempt_at=NULL,error_metadata=NULL,error_class=NULL,error_context=NULL,updated_at=? WHERE id=? AND status IN ('cleaned','failed_summary','summarized')",
  ).bind(forceAllowed ? 1 : 0, forceAllowed ? 1 : 0, forceAllowed ? 1 : 0, new Date().toISOString(), forceAllowed ? 1 : 0, new Date().toISOString(), row.id));
  if (started.success === false || started.error) throw new Error("summary_d1.start_write_failed");
  await lifecycle(row.id, {
    source: forceAllowed ? "summary.resummary" : "summary.generate",
    reasonCode: forceAllowed ? "legacy.summary.resummary_started" : "legacy.summary.started",
    processingState: "running",
  });
  const summarize = options.summarize ?? summarizeArticle;
  let summary: SummaryJson;
  let embedding;
  try {
    summary = await summarize({
      sourceKey: row.source_key,
      jurisdiction: row.jurisdiction,
      institutionName: row.institution_name,
      contentType: row.content_type,
      originalUrl: row.original_url,
      canonicalUrl: row.canonical_url,
      originalLanguage: row.original_language,
      originalTitle: row.original_title ?? undefined,
      originalPublishedAt: row.original_published_at ?? undefined,
      cleanedText: row.cleaned_text ?? undefined,
      metadata: sourceMetadata,
    }, {
      provider: "gemini",
      model: options.model,
      providerApiKeys: { gemini: options.apiKeys },
      allowProviderFallback: true,
    });
    const createEmbedding = options.createEmbedding ?? createEmbeddingArtifact;
    embedding = await createEmbedding(summary, { apiKeys: options.apiKeys, provider: "gemini" }).catch(() => null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = isGlobalSummaryBackoff(message) || /timeout|temporar| 5\d\d\b/i.test(message);
    const errorClass = classifySummaryError(message, retryable);
    const errorMetadata = { message, retryable, requestedProvider: "gemini", requestedModel: options.model ?? null };
    const status = forceAllowed || retryable ? row.status : "failed_summary";
    const now = new Date().toISOString();
    const translationStatus = forceAllowed ? row.translation_status ?? "translated" : retryable ? "pending" : "failed";
    const nextAttemptAt = retryable ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    const saved = await statementRun(core.prepare(
      "UPDATE articles SET status=?,translation_status=?,translation_error_code=?,translation_error_summary=?,translation_next_attempt_at=?,error_metadata=?,error_class=?,error_context=?,review_state=?,updated_at=? WHERE id=?",
    ).bind(status, translationStatus, errorClass, message.slice(0,500), nextAttemptAt, JSON.stringify(errorMetadata), errorClass, JSON.stringify(errorMetadata), retryable ? ARTICLE_REVIEW_STATE.RETRY_LATER : ARTICLE_REVIEW_STATE.NEEDS_TRIAGE, now, row.id));
    if (saved.success === false || saved.error) throw new Error("summary_d1.failure_write_failed");
    await lifecycle(row.id, {
      source: forceAllowed ? "summary.resummary" : "summary.generate",
      reasonCode: "legacy.summary.failed",
      processingState: forceAllowed ? "complete" : "ready",
      ...(retryable ? {} : { reviewState: "needs_review" as const }),
      attention: { operation: "raise", code: errorClass, retryable, severity: "high", source: "processing" },
    });
    return { status: "failed" as const, errorMessage: message, retryable };
  }
  const now = new Date().toISOString();
  const provider = summary.aiMetadata?.provider ?? "gemini";
  const model = summary.aiMetadata?.model ?? options.model ?? null;
  const saved = await statementRun(core.prepare(
    "UPDATE articles SET status='summarized',translation_status=CASE WHEN lower(COALESCE(original_language,''))='ko' THEN 'not_required' ELSE 'translated' END,translated_at=?,translation_provider=?,translation_model=?,translation_error_code=NULL,translation_error_summary=NULL,translation_next_attempt_at=NULL,summarized_at=?,summary_json=?,korean_title=?,error_metadata=NULL,error_class=NULL,error_context=NULL,review_state=?,embedding_provider=NULL,embedding_model=NULL,embedding_dimensions=NULL,embedding_input_hash=NULL,embedding_generated_at=NULL,updated_at=? WHERE id=?",
  ).bind(now, provider, model, now, JSON.stringify(summary), summary.koreanTitle, ARTICLE_REVIEW_STATE.SUMMARIZED, now, row.id));
  if (saved.success === false || saved.error || Number(saved.meta?.changes ?? 0) !== 1) throw new Error("summary_d1.success_write_failed");
  await tryPersistArticleEmbedding(row.id, embedding);
  await lifecycle(row.id, {
    source: forceAllowed ? "summary.resummary" : "summary.generate",
    reasonCode: forceAllowed ? "legacy.summary.resummary_completed" : "legacy.summary.completed",
    collectionState: "source_text_ready",
    processingState: "complete",
    attention: { operation: "clear", resolvesCodes: [...ARTICLE_LIFECYCLE_SUMMARY_ATTENTION_CODES] },
  });
  const tagResult = await syncTags(row.id, summary, row.original_published_at);
  return { status: "summarized" as const, summary, provider, model, tagResult };
}

export async function runD1SummaryDrain(input: {
  limit?: number;
  maxPasses?: number;
  sourceKey?: string;
  retryAttempts?: number;
  retryDelayMs?: number;
  apiKeys: string[];
  model?: string;
  summarize?: typeof summarizeArticle;
  createEmbedding?: typeof createEmbeddingArtifact;
}) {
  const limit = boundedInteger(input.limit, 60, { min: 1, max: 100 });
  const maxPasses = boundedInteger(input.maxPasses, 6, { min: 1, max: 10 });
  const retryAttempts = boundedInteger(input.retryAttempts, 0, { min: 0, max: 3 });
  const retryDelayMs = boundedInteger(input.retryDelayMs, 65_000, { min: 1_000, max: 5 * 60 * 1000 });
  const recoveryLimit = Math.max(limit, 20);
  const recoveredStale = await recoverStaleSummarizing({ limit: recoveryLimit, sourceKey: input.sourceKey });
  const candidateFetchLimit = input.sourceKey ? Math.max(limit * 3, limit) : Math.min(500, Math.max(limit * 10, 100));
  const candidates = await selectCandidates({ limit, sourceKey: input.sourceKey, fetchLimit: candidateFetchLimit });
  let summarizedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let deferredCount = 0;
  let attemptedCount = 0;
  let retryCount = 0;
  let passes = 0;
  let stoppedReason: string | undefined;
  let limitReached = false;
  const summarizedBySource: Record<string, number> = {};
  const deferredBySource: Record<string, number> = {};
  const runIds = new Set<string>();
  const keys = input.apiKeys.map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0) {
    return { mode: "database" as const, status: "unavailable" as const, summarizedCount, failedCount, skippedCount, deferredCount, candidateCount: candidates.length, attemptedCount, retryCount, passes, limitReached: candidates.length > 0, stoppedReason: "Gemini API key is not configured.", recoveredStale };
  }
  let exhaustedPasses = true;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    passes += 1;
    let passSummarized = 0;
    let passAttempted = 0;
    const passCandidates = await selectCandidates({ limit, sourceKey: input.sourceKey, fetchLimit: candidateFetchLimit });
    if (passCandidates.length === 0) {
      exhaustedPasses = false;
      break;
    }
    for (const row of passCandidates) {
      if (passSummarized >= limit) {
        limitReached = true;
        break;
      }
      attemptedCount += 1;
      passAttempted += 1;
      let result = await summarizeCandidate(row, { apiKeys: keys, model: input.model, summarize: input.summarize, createEmbedding: input.createEmbedding });
      for (let retryIndex = 0; result.status === "failed" && result.retryable && retryIndex < retryAttempts; retryIndex += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, summaryRetryDelayMs(result.errorMessage, retryIndex, retryDelayMs)));
        retryCount += 1;
        result = await summarizeCandidate(row, { apiKeys: keys, model: input.model, summarize: input.summarize, createEmbedding: input.createEmbedding });
      }
      if (result.status === "skipped") {
        skippedCount += 1;
      } else if (result.status === "summarized") {
        summarizedCount += 1;
        passSummarized += 1;
        summarizedBySource[row.source_key] = (summarizedBySource[row.source_key] ?? 0) + 1;
        const runId = ingestionRunIdFromSourceMetadata(row.source_metadata);
        if (runId) runIds.add(runId);
      } else {
        failedCount += 1;
        if (result.retryable) {
          deferredCount += 1;
          deferredBySource[row.source_key] = (deferredBySource[row.source_key] ?? 0) + 1;
          stoppedReason = result.errorMessage;
          exhaustedPasses = false;
          break;
        }
      }
    }
    if (stoppedReason || passSummarized === 0 || passAttempted < passCandidates.length) {
      exhaustedPasses = false;
      break;
    }
  }
  const ingestionRunSummaryCounts = await syncIngestionRunCounts(runIds);
  const tagRefresh = summarizedCount > 0 ? await refreshTagCounts() : undefined;
  if (exhaustedPasses && summarizedCount && passes >= maxPasses) {
    const remaining = await selectCandidates({ limit, sourceKey: input.sourceKey, fetchLimit: candidateFetchLimit });
    if (remaining.length > 0) stoppedReason = "Summary drain reached its maximum pass count.";
  }
  return {
    mode: "database" as const,
    status: stoppedReason ? "deferred" as const : failedCount > 0 ? "failed" as const : "completed" as const,
    summarizedCount,
    failedCount,
    skippedCount,
    deferredCount,
    candidateCount: candidates.length,
    attemptedCount,
    retryCount,
    passes,
    limitReached,
    stoppedReason,
    summarizedBySource,
    deferredBySource,
    ingestionRunSummaryCounts,
    recoveredStale,
    tagRefresh,
  };
}
