import { articlePublicationService } from "@/lib/article-publication/service";
import type { ArticlePublicationTransitionInput } from "@/lib/article-publication/types";
import { getRuntimeD1Binding, type D1RuntimePreparedStatement } from "@/lib/cloudflare/d1/runtime-binding";
import { boundedInteger } from "@/lib/utils/numbers";

type Row = Record<string, unknown>;

function ensureSuccess<T>(result: { success?: boolean; error?: string | null; results?: T[] }) {
  if (result.success === false || result.error) throw new Error("publication_d1.query_failed");
  return result.results ?? [];
}

function statementRun(statement: D1RuntimePreparedStatement) {
  if (!statement.run) throw new Error("publication_d1.write_unavailable");
  return statement.run();
}

function core() {
  const binding = getRuntimeD1Binding("worldcons_core");
  if (!binding) throw new Error("publication_d1.core_binding_missing");
  return binding;
}

function transitionKey(articleId: string, revision: number) {
  return `publication-drain:${articleId}:${revision}`;
}

function parseSummaryMetadata(value: unknown) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const ai = (parsed as Record<string, unknown>).aiMetadata;
    return ai && typeof ai === "object" && !Array.isArray(ai) ? ai as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * The exact public-publication eligibility predicate. A single source of truth
 * shared by the batch drain and the per-article stage handler, so the staged
 * pipeline can never publish a row the drain would have refused.
 */
export const P3_PUBLICATION_ELIGIBLE_PREDICATE = `
  a.status='summarized'
    AND a.summary_json IS NOT NULL
    AND (
      a.translation_status='translated'
      OR (lower(COALESCE(a.original_language,''))='ko' AND a.translation_status='not_required')
    )
    AND json_valid(a.source_metadata)
    AND COALESCE(json_extract(a.source_metadata,'$.collection.publishable'),json_extract(a.source_metadata,'$.case.collection.publishable'))=1
    AND COALESCE(p.state,'')<>'published'
`;

async function publishArticle(row: Row, actorId = "m8-publication-drain") {
  const articleId = String(row.id ?? "");
  const current = await articlePublicationService.getSnapshot(articleId);
  if (!current.ok) throw new Error(`publication_d1.snapshot:${current.error.code}`);
  const ai = parseSummaryMetadata(row.summary_json);
  const provider = typeof ai.provider === "string" ? ai.provider : "gemini";
  const model = typeof ai.model === "string" ? ai.model : null;
  const result = await articlePublicationService.transition({
    articleId,
    expectedVersionRevision: current.data.versionRevision,
    expectedPublicationRevision: current.data.publicationRevision,
    expectedLegacyUpdatedAt: current.data.legacyUpdatedAt,
    idempotencyKey: transitionKey(articleId, current.data.publicationRevision),
    targetState: "published",
    captureLegacy: true,
    actorType: "compatibility",
    actorId,
    reason: "Translation, summary and enrichment completed; release to public publication.",
    provenanceActorType: "llm",
    provenanceActorId: provider,
    modelRef: model,
  } satisfies ArticlePublicationTransitionInput);
  if (!result.ok) throw new Error(`publication_d1.transition:${result.error.code}`);
  const ingest = getRuntimeD1Binding("worldcons_ingest");
  if (ingest) {
    const now = new Date().toISOString();
    const updated = await statementRun(ingest.prepare(
      "UPDATE source_backfill_items SET status='published',published_normalization_artifact_id=COALESCE(published_normalization_artifact_id,verified_normalization_artifact_id),updated_at=? WHERE article_id=? AND status IN ('verified','withdrawn')",
    ).bind(now, articleId));
    if (updated.success === false || updated.error) throw new Error("publication_d1.backfill_sync_failed");
  }
  return result.data;
}

async function reconcileSearchFreshnessForVersion(articleId: string, versionId: string, contentHash: unknown, classifiedBy: string) {
  if (!versionId || !articleId) return 0;
  const now = new Date().toISOString();
  const evidence = JSON.stringify({
    reason: "translation_summary_publication_complete",
    publicationPipeline: classifiedBy,
  });
  const result = await statementRun(core().prepare(`
    INSERT INTO legacy_version_freshness_classifications_v4
      (version_id,article_id,freshness,freshness_basis,source_anchor_version_id,source_content_hash,evidence,classified_at,classified_by)
    VALUES (?,?,'current','legacy_same_version',NULL,?,?,?,?)
    ON CONFLICT(version_id) DO UPDATE SET
      article_id=excluded.article_id,
      freshness='current',
      freshness_basis='legacy_same_version',
      source_anchor_version_id=NULL,
      source_content_hash=excluded.source_content_hash,
      evidence=excluded.evidence,
      classified_at=excluded.classified_at,
      classified_by=excluded.classified_by
  `).bind(versionId, articleId, contentHash ?? null, evidence, now, classifiedBy));
  if (result.success === false || result.error) throw new Error("publication_d1.search_freshness_sync_failed");
  return 1;
}

async function reconcilePublishedSearchFreshness(limit: number) {
  const rows = ensureSuccess(await core().prepare(`
    SELECT p.article_id,p.version_id,v.content_hash
    FROM article_publications_p3 p
    JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=p.article_id
    LEFT JOIN legacy_version_freshness_classifications_v4 f ON f.version_id=v.id
    WHERE p.state='published'
      AND v.version_role IS NULL
      AND (f.version_id IS NULL OR f.freshness<>'current')
    ORDER BY p.updated_at ASC,p.article_id ASC
    LIMIT ?
  `).bind(limit).all<Row>());
  let reconciled = 0;
  for (const row of rows) {
    reconciled += await reconcileSearchFreshnessForVersion(
      String(row.article_id ?? ""),
      String(row.version_id ?? ""),
      row.content_hash,
      "m8-publication-drain",
    );
  }
  return reconciled;
}

async function reconcilePublishedSearchFreshnessForArticle(articleId: string, versionId: string) {
  const rows = ensureSuccess(await core().prepare(`
    SELECT p.article_id,p.version_id,v.content_hash
    FROM article_publications_p3 p
    JOIN article_content_versions_p3 v ON v.id=p.version_id AND v.article_id=p.article_id
    WHERE p.article_id=?
      AND p.version_id=?
      AND p.state='published'
      AND v.version_role IS NULL
    LIMIT 1
  `).bind(articleId, versionId).all<Row>());
  const row = rows[0];
  if (!row) return 0;
  return reconcileSearchFreshnessForVersion(String(row.article_id), String(row.version_id), row.content_hash, "ingest-stage-publish");
}

export interface RunD1PublishArticleResult {
  articleId: string;
  published: boolean;
  skippedReason: "not_found" | "ineligible" | null;
  state: string | null;
  versionId: string | null;
  publicationRevision: number | null;
  idempotent: boolean;
  searchFreshnessReconciled: number;
}

/**
 * Publishes exactly one article id through the same P3 authority transition as
 * the batch drain. This is the per-article primitive the staged `publish` stage
 * uses instead of a global all-pending drain: it can only ever touch the article
 * named by `articleId`, so an unrelated pending publication is never swept up.
 *
 * Idempotent through the underlying `articlePublicationService.transition`
 * request ledger. A row that is not eligible (already published, unpublished,
 * missing, or failing any gate) returns `published: false` with an explicit
 * `skippedReason` and performs no write.
 */
export async function runD1PublishArticle(input: { articleId: string; actorId?: string }): Promise<RunD1PublishArticleResult> {
  const articleId = input.articleId?.trim();
  if (!articleId) throw new Error("publication_d1.article_id_required");
  const actorId = input.actorId?.trim() || "ingest-stage-publish";
  const rows = ensureSuccess(await core().prepare(`
    SELECT a.id,a.summary_json
    FROM articles a
    LEFT JOIN article_publications_p3 p ON p.article_id=a.id
    WHERE a.id=?
      AND ${P3_PUBLICATION_ELIGIBLE_PREDICATE}
    LIMIT 1
  `).bind(articleId).all<Row>());
  const row = rows[0];
  if (!row) {
    // Distinguish an already-published article (a replay after a crash between
    // the durable transition and the job completion) from a genuinely
    // ineligible/missing one. An already-published article is an idempotent
    // success, not a block: the work is durably done and the pipeline should
    // advance to search.
    const existing = ensureSuccess(await core().prepare(
      "SELECT state,version_id,revision FROM article_publications_p3 WHERE article_id=? AND state='published' LIMIT 1",
    ).bind(articleId).all<Row>())[0];
    if (existing) {
      const versionId = typeof existing.version_id === "string" ? existing.version_id : null;
      const searchFreshnessReconciled = versionId ? await reconcilePublishedSearchFreshnessForArticle(articleId, versionId) : 0;
      return {
        articleId,
        published: true,
        skippedReason: null,
        state: "published",
        versionId,
        publicationRevision: Number(existing.revision ?? 0) || null,
        idempotent: true,
        searchFreshnessReconciled,
      };
    }
    const exists = ensureSuccess(await core().prepare("SELECT 1 AS present FROM articles WHERE id=?").bind(articleId).all<{ present: number | string }>());
    return {
      articleId,
      published: false,
      skippedReason: exists[0] ? "ineligible" : "not_found",
      state: null,
      versionId: null,
      publicationRevision: null,
      idempotent: false,
      searchFreshnessReconciled: 0,
    };
  }
  const data = await publishArticle(row, actorId);
  const searchFreshnessReconciled = await reconcilePublishedSearchFreshnessForArticle(articleId, data.versionId);
  return {
    articleId,
    published: true,
    skippedReason: null,
    state: data.publicationState,
    versionId: data.versionId,
    publicationRevision: data.publicationRevision,
    idempotent: data.idempotent,
    searchFreshnessReconciled,
  };
}

export async function runD1PublicationDrain(input: { limit?: number } = {}) {
  const limit = boundedInteger(input.limit, 50, { min: 1, max: 500 });
  const rows = ensureSuccess(await core().prepare(`
    SELECT a.id,a.summary_json
    FROM articles a
    LEFT JOIN article_publications_p3 p ON p.article_id=a.id
    WHERE ${P3_PUBLICATION_ELIGIBLE_PREDICATE}
    ORDER BY a.summarized_at ASC,a.id ASC
    LIMIT ?
  `).bind(limit).all<Row>());
  let publishedCount = 0;
  let failedCount = 0;
  const failures: Array<{ articleId: string; error: string }> = [];
  for (const row of rows) {
    try {
      await publishArticle(row);
      publishedCount += 1;
    } catch (error) {
      failedCount += 1;
      failures.push({ articleId: String(row.id ?? ""), error: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    }
  }
  const searchFreshnessReconciled = await reconcilePublishedSearchFreshness(Math.max(limit * 2, 100));
  const remaining = ensureSuccess(await core().prepare(`
    SELECT COUNT(*) AS count
    FROM articles a LEFT JOIN article_publications_p3 p ON p.article_id=a.id
    WHERE ${P3_PUBLICATION_ELIGIBLE_PREDICATE}
  `).all<{ count: number | string }>())[0];
  return {
    mode: "database" as const,
    status: failedCount > 0 ? "degraded" as const : "completed" as const,
    selectedCount: rows.length,
    publishedCount,
    failedCount,
    remainingCount: Number(remaining?.count ?? 0),
    searchFreshnessReconciled,
    failures,
  };
}
