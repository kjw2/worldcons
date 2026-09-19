import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import type { ArticleRawInlineClearRepository } from "@/lib/article-raw/inline-clear";

/**
 * M6C repository: list inline article raw_text rows with every externalization
 * column and route the single permit-guarded clear to the M6C inline-clear RPC.
 *
 * The candidate query intentionally selects all five raw blob metadata columns and
 * does not filter to fully externalized rows: the service classifies each row
 * before any Blob read, so a partial or missing metadata set must be visible to be
 * reported as `metadata_conflict` / `not_ready` rather than silently skipped. Rows
 * without inline raw_text are excluded, since there is nothing to clear.
 *
 * For `articles` the row id is the article id. For `article_content_versions_p3`
 * the row id is the version id. Keyset pagination on the row id keeps every batch
 * bounded and stable across reruns.
 */

type Row = Record<string, unknown>;

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

function metadataFields(row: Row) {
  return {
    rawTextStorageRef: optionalText(row.raw_text_storage_ref),
    rawTextBlobHash: optionalText(row.raw_text_blob_hash),
    rawTextBlobSize: optionalSize(row.raw_text_blob_size),
    rawTextExternalizedAt: optionalText(row.raw_text_externalized_at),
    rawTextBlobContractVersion: optionalText(row.raw_text_blob_contract_version),
  };
}

export interface ArticleRawInlineClearRepositoryDependencies {
  client?: () => SupabaseClient | null;
}

function requiredClient(client: () => SupabaseClient | null) {
  const resolved = client();
  if (!resolved) throw new Error("article_raw_inline_clear.database_unavailable");
  return resolved;
}

function databaseError(error: { message?: string } | null) {
  if (error) throw new Error(error.message || "article_raw_inline_clear.database_error");
}

const ARTICLE_RAW_BLOB_METADATA_SELECT =
  "raw_text_storage_ref,raw_text_blob_hash,raw_text_blob_size,raw_text_externalized_at,raw_text_blob_contract_version";
const ARTICLE_RAW_BLOB_ROW_SELECT = `id,source_key,raw_text,${ARTICLE_RAW_BLOB_METADATA_SELECT}`;

export function createPostgresArticleRawInlineClearRepository(
  dependencies: ArticleRawInlineClearRepositoryDependencies = {},
): ArticleRawInlineClearRepository {
  const client = dependencies.client ?? getSupabaseServiceRoleAdmin;
  return {
    /**
     * M6C candidates: every inline raw_text row, each carrying all five
     * externalization columns so the service can classify it before any Blob read.
     * Both target tables share the same projected columns.
     */
    async listArticleRawInlineClearCandidates(input) {
      const supabase = requiredClient(client);
      let query = supabase
        .from(input.articleTable)
        .select(ARTICLE_RAW_BLOB_ROW_SELECT)
        .not("raw_text", "is", null)
        .order("id", { ascending: true })
        .limit(input.limit);
      if (input.afterArticleRowId) query = query.gt("id", input.afterArticleRowId);
      if (input.sourceKey) query = query.eq("source_key", input.sourceKey);
      const { data, error } = await query;
      databaseError(error);
      return (Array.isArray(data) ? data : []).filter(isRecord).flatMap((row) => {
        const articleRowId = typeof row.id === "string" ? row.id : "";
        const sourceKey = typeof row.source_key === "string" ? row.source_key : "";
        const rawText = typeof row.raw_text === "string" ? row.raw_text : null;
        if (!articleRowId || !sourceKey || rawText === null) return [];
        return [{
          articleTable: input.articleTable,
          articleRowId,
          sourceKey,
          rawText,
          ...metadataFields(row),
        }];
      });
    },
    /**
     * The single permit-guarded M6C clear, always explicit `p_dry_run = false` with
     * the exact ref/hash/size/contract/actor. An already cleared row returns
     * `idempotent: true` and performs no second update.
     */
    async clearArticleRawInline(input) {
      const { data, error } = await requiredClient(client).rpc("article_raw_inline_clear_v1", {
        p_article_table: input.articleTable,
        p_article_row_id: input.articleRowId,
        p_expected_storage_ref: input.expectedStorageRef,
        p_expected_content_hash: input.expectedContentHash,
        p_expected_content_size: input.expectedContentSize,
        p_externalization_contract_version: input.externalizationContractVersion,
        p_actor_id: input.actorId,
        p_dry_run: false,
      });
      databaseError(error);
      const row = firstRow(data);
      const articleRowId = row && typeof row.articleRowId === "string" ? row.articleRowId : "";
      if (!row || !articleRowId) throw new Error("article_raw_inline_clear.clear_failed");
      return { articleRowId, idempotent: row.idempotent === true };
    },
  };
}

export const postgresArticleRawInlineClearRepository =
  createPostgresArticleRawInlineClearRepository();
