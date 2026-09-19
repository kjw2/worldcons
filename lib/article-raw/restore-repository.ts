import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import type {
  ArticleRawRestoreCandidate,
  ArticleRawRestoreRepository,
  ArticleRawRestoreTable,
} from "@/lib/article-raw/restore";

/**
 * M6E repository: list blob-only article raw_text candidates through the M6E
 * read-only authority RPC and route the single permit-guarded restore to the M6E
 * restore RPC. Candidate listing never reads the raw-text tables directly:
 * service_role holds no raw-column SELECT on article_content_versions_p3, so the
 * narrow read RPC is the only supported authority.
 *
 * The M6E read RPC returns only rows with no inline `raw_text` and carries all five
 * raw blob metadata columns without filtering to fully externalized rows: the
 * service classifies each row before any Blob read, so a partial or missing metadata
 * set must be visible to be reported as `conflict` / `not_ready` rather than
 * silently skipped.
 *
 * For `articles` the row id is the article id. For `article_content_versions_p3`
 * the row id is the version id. Keyset pagination on the row id keeps every batch
 * bounded and stable across reruns.
 */

type Row = Record<string, unknown>;

const ARTICLE_RAW_RESTORE_LIST_RPC = "article_raw_restore_candidates_v1";
const ARTICLE_RAW_RESTORE_RPC = "article_raw_restore_inline_v1";

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRow(value: unknown) {
  if (Array.isArray(value)) return isRecord(value[0]) ? value[0] : null;
  return isRecord(value) ? value : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function optionalSize(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (value.trim() !== "" && Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function restoreTable(value: unknown, fallback: ArticleRawRestoreTable): ArticleRawRestoreTable {
  return value === "articles" || value === "article_content_versions_p3" ? value : fallback;
}

function candidateFromRow(
  row: Row,
  fallbackTable: ArticleRawRestoreTable,
): ArticleRawRestoreCandidate | null {
  const articleRowId = typeof row.article_row_id === "string" ? row.article_row_id : "";
  const sourceKey = typeof row.source_key === "string" ? row.source_key : "";
  if (!articleRowId || !sourceKey) return null;
  return {
    articleTable: restoreTable(row.article_table, fallbackTable),
    articleRowId,
    sourceKey,
    rawTextStorageRef: optionalText(row.raw_text_storage_ref),
    rawTextBlobHash: optionalText(row.raw_text_blob_hash),
    rawTextBlobSize: optionalSize(row.raw_text_blob_size),
    rawTextExternalizedAt: optionalText(row.raw_text_externalized_at),
    rawTextBlobContractVersion: optionalText(row.raw_text_blob_contract_version),
  };
}

export interface ArticleRawRestoreRepositoryDependencies {
  client?: () => SupabaseClient | null;
}

function requiredClient(client: () => SupabaseClient | null) {
  const resolved = client();
  if (!resolved) throw new Error("article_raw_restore.database_unavailable");
  return resolved;
}

function databaseError(error: { message?: string } | null) {
  if (error) throw new Error(error.message || "article_raw_restore.database_error");
}

export function createPostgresArticleRawRestoreRepository(
  dependencies: ArticleRawRestoreRepositoryDependencies = {},
): ArticleRawRestoreRepository {
  const client = dependencies.client ?? getSupabaseServiceRoleAdmin;
  return {
    /**
     * M6E candidates: every blob-only raw_text row, each carrying all five
     * externalization columns so the service can classify it before any Blob read.
     * Both target tables share the same M6E read projection.
     */
    async listArticleRawRestoreCandidates(input) {
      const { data, error } = await requiredClient(client).rpc(ARTICLE_RAW_RESTORE_LIST_RPC, {
        p_article_table: input.articleTable,
        p_source_key: input.sourceKey ?? null,
        p_after_row_id: input.afterArticleRowId ?? null,
        p_limit: input.limit,
      });
      databaseError(error);
      if (!Array.isArray(data)) return [];
      return data.filter(isRecord).flatMap((row) => {
        const candidate = candidateFromRow(row, input.articleTable);
        return candidate ? [candidate] : [];
      });
    },
    /**
     * The single permit-guarded M6E restore, always explicit `p_dry_run = false` with
     * the decoded inline raw_text and the exact ref/hash/size/contract/actor. An
     * already-restored row returns `idempotent: true` and performs no second update.
     */
    async restoreArticleRawInline(input) {
      const { data, error } = await requiredClient(client).rpc(ARTICLE_RAW_RESTORE_RPC, {
        p_article_table: input.articleTable,
        p_article_row_id: input.articleRowId,
        p_raw_text: input.rawText,
        p_storage_ref: input.storageRef,
        p_content_hash: input.contentHash,
        p_content_size: input.contentSize,
        p_externalization_contract_version: input.externalizationContractVersion,
        p_actor_id: input.actorId,
        p_dry_run: false,
      });
      databaseError(error);
      const row = firstRow(data);
      const articleRowId = row && typeof row.articleRowId === "string" ? row.articleRowId : "";
      if (!row || !articleRowId) throw new Error("article_raw_restore.restore_failed");
      return { articleRowId, idempotent: row.idempotent === true };
    },
  };
}

export const postgresArticleRawRestoreRepository = createPostgresArticleRawRestoreRepository();
