import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import type {
  ArticleRawInlineClearCandidate,
  ArticleRawInlineClearRepository,
  ArticleRawInlineClearTable,
} from "@/lib/article-raw/inline-clear";

/**
 * M6C repository: list inline article raw_text candidates through the M6D-A
 * operator read authority RPC and route the single permit-guarded clear to the M6C
 * inline-clear RPC. Candidate listing never reads the raw-text tables directly:
 * service_role holds no raw-column SELECT on article_content_versions_p3, so the
 * narrow read RPC is the only supported authority.
 *
 * The M6D-A read RPC returns all five raw blob metadata columns and does not filter
 * to fully externalized rows: the service classifies each row before any Blob read,
 * so a partial or missing metadata set must be visible to be reported as
 * `metadata_conflict` / `not_ready` rather than silently skipped. Rows without
 * inline raw_text are excluded, since there is nothing to clear.
 *
 * For `articles` the row id is the article id. For `article_content_versions_p3`
 * the row id is the version id. Keyset pagination on the row id keeps every batch
 * bounded and stable across reruns.
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

function operatorTable(value: unknown, fallback: ArticleRawInlineClearTable): ArticleRawInlineClearTable {
  return value === "articles" || value === "article_content_versions_p3" ? value : fallback;
}

function candidateFromRow(
  row: Row,
  fallbackTable: ArticleRawInlineClearTable,
): ArticleRawInlineClearCandidate | null {
  const articleRowId = typeof row.article_row_id === "string" ? row.article_row_id : "";
  const sourceKey = typeof row.source_key === "string" ? row.source_key : "";
  const rawText = typeof row.raw_text === "string" ? row.raw_text : null;
  if (!articleRowId || !sourceKey || rawText === null) return null;
  return {
    articleTable: operatorTable(row.article_table, fallbackTable),
    articleRowId,
    sourceKey,
    rawText,
    ...metadataFields(row),
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

export function createPostgresArticleRawInlineClearRepository(
  dependencies: ArticleRawInlineClearRepositoryDependencies = {},
): ArticleRawInlineClearRepository {
  const client = dependencies.client ?? getSupabaseServiceRoleAdmin;
  return {
    /**
     * M6C candidates: every inline raw_text row, each carrying all five
     * externalization columns so the service can classify it before any Blob read.
     * Both target tables share the same M6D-A read projection.
     */
    async listArticleRawInlineClearCandidates(input) {
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
