import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import type { ArticleRawExternalizationRepository } from "@/lib/article-raw/externalization";

/**
 * M6B repository: list article raw_text rows with every externalization column and
 * route the single permit-guarded attach to the M6B externalization RPC. It never
 * writes the externalization columns directly and never clears inline raw_text.
 *
 * The candidate query intentionally selects all five raw blob metadata columns and
 * does not filter to ref-less rows: the service classifies each row before any
 * upload, so an already externalized row (all five columns present) must be visible
 * to be reported as idempotent rather than being skipped.
 *
 * For `articles` the row id is the article id. For `article_content_versions_p3`
 * the row id is the version id, and the article id is carried alongside for the
 * append-only ledger.
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

export interface ArticleRawExternalizationRepositoryDependencies {
  client?: () => SupabaseClient | null;
}

function requiredClient(client: () => SupabaseClient | null) {
  const resolved = client();
  if (!resolved) throw new Error("article_raw_externalization.database_unavailable");
  return resolved;
}

function databaseError(error: { message?: string } | null) {
  if (error) throw new Error(error.message || "article_raw_externalization.database_error");
}

const ARTICLE_RAW_BLOB_METADATA_SELECT =
  "raw_text_storage_ref,raw_text_blob_hash,raw_text_blob_size,raw_text_externalized_at,raw_text_blob_contract_version";
const ARTICLE_RAW_BLOB_ROW_SELECT = `id,source_key,raw_text,${ARTICLE_RAW_BLOB_METADATA_SELECT}`;
const ARTICLE_RAW_VERSION_ROW_SELECT = `id,article_id,source_key,raw_text,${ARTICLE_RAW_BLOB_METADATA_SELECT}`;

export function createPostgresArticleRawExternalizationRepository(
  dependencies: ArticleRawExternalizationRepositoryDependencies = {},
): ArticleRawExternalizationRepository {
  const client = dependencies.client ?? getSupabaseServiceRoleAdmin;
  return {
    /**
     * M6B candidates: every inline raw_text row, each carrying all five
     * externalization columns so the service can classify it before any upload.
     * Keyset pagination on the row id keeps every batch bounded and stable across
     * reruns.
     */
    async listArticleRawExternalizationCandidates(input) {
      const supabase = requiredClient(client);
      if (input.articleTable === "articles") {
        let query = supabase
          .from("articles")
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
          return [{ articleTable: "articles" as const, articleRowId, articleId: articleRowId, sourceKey, rawText, ...metadataFields(row) }];
        });
      }
      let query = supabase
        .from("article_content_versions_p3")
        .select(ARTICLE_RAW_VERSION_ROW_SELECT)
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
        const articleId = typeof row.article_id === "string" ? row.article_id : "";
        if (!articleRowId || !sourceKey || !articleId || rawText === null) return [];
        return [{ articleTable: "article_content_versions_p3" as const, articleRowId, articleId, sourceKey, rawText, ...metadataFields(row) }];
      });
    },
    async attachArticleRawExternalization(input) {
      const { data, error } = await requiredClient(client).rpc("article_raw_externalize_v1", {
        p_article_table: input.articleTable,
        p_article_row_id: input.articleRowId,
        p_storage_ref: input.storageRef,
        p_content_hash: input.contentHash,
        p_content_size: input.contentSize,
        p_externalization_contract_version: input.externalizationContractVersion,
        p_actor_id: input.actorId,
      });
      databaseError(error);
      const row = firstRow(data);
      const articleRowId = row && typeof row.artifactId === "string" ? row.artifactId : "";
      if (!row || !articleRowId) throw new Error("article_raw_externalization.attach_failed");
      return { articleRowId, idempotent: row.idempotent === true };
    },
  };
}

export const postgresArticleRawExternalizationRepository =
  createPostgresArticleRawExternalizationRepository();
