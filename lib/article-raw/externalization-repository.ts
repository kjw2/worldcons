import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import type {
  ArticleRawExternalizationCandidate,
  ArticleRawExternalizationRepository,
  ArticleRawExternalizationTable,
} from "@/lib/article-raw/externalization";

/**
 * M6B repository: list article raw_text candidates through the M6D-A operator read
 * authority RPC and route the single permit-guarded attach to the M6B
 * externalization RPC. Candidate listing never reads the raw-text tables directly:
 * service_role holds no raw-column SELECT on article_content_versions_p3, so the
 * narrow read RPC is the only supported authority. This repository never writes the
 * externalization columns directly and never clears inline raw_text.
 *
 * The M6D-A read RPC returns all five raw blob metadata columns and does not filter
 * to ref-less rows: the service classifies each row before any upload, so an already
 * externalized row (all five columns present) must be visible to be reported as
 * idempotent rather than being skipped.
 *
 * For `articles` the row id is the article id. For `article_content_versions_p3`
 * the row id is the version id, and the article id is carried alongside for the
 * append-only ledger.
 */

type Row = Record<string, unknown>;

const ARTICLE_RAW_OPERATOR_READ_RPC = "article_raw_operator_candidates_v1";

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

function operatorTable(value: unknown, fallback: ArticleRawExternalizationTable): ArticleRawExternalizationTable {
  return value === "articles" || value === "article_content_versions_p3" ? value : fallback;
}

function candidateFromRow(
  row: Row,
  fallbackTable: ArticleRawExternalizationTable,
): ArticleRawExternalizationCandidate | null {
  const articleRowId = typeof row.article_row_id === "string" ? row.article_row_id : "";
  const articleId = typeof row.article_id === "string" ? row.article_id : "";
  const sourceKey = typeof row.source_key === "string" ? row.source_key : "";
  const rawText = typeof row.raw_text === "string" ? row.raw_text : null;
  if (!articleRowId || !articleId || !sourceKey || rawText === null) return null;
  return {
    articleTable: operatorTable(row.article_table, fallbackTable),
    articleRowId,
    articleId,
    sourceKey,
    rawText,
    ...metadataFields(row),
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

export function createPostgresArticleRawExternalizationRepository(
  dependencies: ArticleRawExternalizationRepositoryDependencies = {},
): ArticleRawExternalizationRepository {
  const client = dependencies.client ?? getSupabaseServiceRoleAdmin;
  return {
    /**
     * M6B candidates: every inline raw_text row, each carrying all five
     * externalization columns so the service can classify it before any upload. The
     * M6D-A read RPC keyset paginates on the row id so every batch is bounded and
     * stable across reruns.
     */
    async listArticleRawExternalizationCandidates(input) {
      const { data, error } = await requiredClient(client).rpc(ARTICLE_RAW_OPERATOR_READ_RPC, {
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
