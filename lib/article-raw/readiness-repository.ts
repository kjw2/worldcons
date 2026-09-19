import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import type { ArticleRawReadinessTable } from "@/lib/article-raw/readiness";

/**
 * M6D-B repository (hardened): read the single aggregate article raw_text readiness
 * row through the read-only article_raw_readiness_v1 RPC.
 *
 * The aggregate RPC is the only supported readiness authority: service_role holds no
 * raw-column grant on article_content_versions_p3 and only a narrow grant on
 * articles, so readiness never reads the raw-text tables directly. This repository
 * calls exactly one RPC per read, maps exactly one aggregate row, and never
 * paginates, never transfers a storage ref, hash, size, or raw payload, and never
 * touches Blob storage.
 */

export const ARTICLE_RAW_READINESS_RPC = "article_raw_readiness_v1";

type Row = Record<string, unknown>;

export interface ArticleRawReadinessAggregate {
  totalRows: number;
  inlinePresent: number;
  inlineMissing: number;
  metadataAbsent: number;
  metadataComplete: number;
  metadataInconsistent: number;
  dualCopy: number;
  blobOnly: number;
  inlineOnly: number;
  exactLedgerCovered: number;
  ledgerMissingOrConflicting: number;
  clearableRows: number;
  inlineBlobBytesEstimated: number;
}

export interface ReadArticleRawReadinessInput {
  articleTable: ArticleRawReadinessTable;
  sourceKey?: string | null;
}

export interface ArticleRawReadinessAggregateRepository {
  readArticleRawReadiness(input: ReadArticleRawReadinessInput): Promise<ArticleRawReadinessAggregate>;
}

export interface ArticleRawReadinessRepositoryDependencies {
  client?: () => SupabaseClient | null;
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function aggregateCount(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return 0;
}

function mapAggregateRow(row: Row): ArticleRawReadinessAggregate {
  return {
    totalRows: aggregateCount(row.total_rows),
    inlinePresent: aggregateCount(row.inline_present),
    inlineMissing: aggregateCount(row.inline_missing),
    metadataAbsent: aggregateCount(row.metadata_absent),
    metadataComplete: aggregateCount(row.metadata_complete),
    metadataInconsistent: aggregateCount(row.metadata_inconsistent),
    dualCopy: aggregateCount(row.dual_copy),
    blobOnly: aggregateCount(row.blob_only),
    inlineOnly: aggregateCount(row.inline_only),
    exactLedgerCovered: aggregateCount(row.exact_ledger_covered),
    ledgerMissingOrConflicting: aggregateCount(row.ledger_missing_or_conflicting),
    clearableRows: aggregateCount(row.clearable_rows),
    inlineBlobBytesEstimated: aggregateCount(row.inline_blob_bytes_estimated),
  };
}

function requiredClient(client: () => SupabaseClient | null) {
  const resolved = client();
  if (!resolved) throw new Error("article_raw_readiness.database_unavailable");
  return resolved;
}

function databaseError(error: { message?: string } | null) {
  if (error) throw new Error(error.message || "article_raw_readiness.database_error");
}

export function createPostgresArticleRawReadinessRepository(
  dependencies: ArticleRawReadinessRepositoryDependencies = {},
): ArticleRawReadinessAggregateRepository {
  const client = dependencies.client ?? getSupabaseServiceRoleAdmin;
  return {
    /**
     * The aggregate RPC returns exactly one row for the selected table, optionally
     * narrowed by an exact source key. A missing or malformed row is refused rather
     * than reported as an empty readiness state.
     */
    async readArticleRawReadiness(input: ReadArticleRawReadinessInput) {
      const { data, error } = await requiredClient(client).rpc(ARTICLE_RAW_READINESS_RPC, {
        p_article_table: input.articleTable,
        p_source_key: input.sourceKey ?? null,
      });
      databaseError(error);
      const rows = Array.isArray(data) ? data.filter(isRecord) : [];
      if (rows.length !== 1) throw new Error("article_raw_readiness.aggregate_unexpected");
      return mapAggregateRow(rows[0]);
    },
  };
}

export const postgresArticleRawReadinessRepository = createPostgresArticleRawReadinessRepository();
