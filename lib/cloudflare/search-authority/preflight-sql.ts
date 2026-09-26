import {
  SEMANTIC_PROVENANCE_AUDIT_SQL,
  type SemanticProvenanceAuditReport,
} from "@/lib/cloudflare/search-vector";
import {
  BASELINE_ARTIFACT_BACKED_CURRENT_PUBLISHED_ROWS,
  BASELINE_CURRENT_PUBLISHED_ROWS,
  BASELINE_LEGACY_VERSION_EMBEDDING_ONLY_COUNT,
  BASELINE_PROJECTION_EMBEDDING_NULL_COUNT,
  BASELINE_PROJECTION_ROWS,
  BASELINE_TOTAL_MISMATCH_COUNT,
  MIGRATION_VERSION,
} from "./migration-contract";

/**
 * M7.8-A read-only preflight SQL authored here (pure, runtime-neutral) plus the
 * fail-closed baseline and post-apply validation contracts.
 *
 * Every statement in this module is a single read-only `select`. The operator
 * script passes them to `supabase db query --linked`; nothing here writes a row.
 * The preflight captures the live column order, the target-version absence, the
 * provenance counts baseline and a content-free id count+digest of the current
 * projection, all before any apply decision.
 */

/** The ordered live `public_article_projection_p3` column names. */
export const PROJECTION_COLUMNS_SQL = `select a.attname as column_name
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'public_article_projection_p3'
  and a.attnum > 0 and not a.attisdropped
order by a.attnum`;

/** A read-only target-version presence probe against the remote migration ledger. */
export function remoteTargetVersionSql(version: string = MIGRATION_VERSION): string {
  if (!/^\d{14}$/u.test(version)) throw new Error("remoteTargetVersionSql requires a 14-digit version");
  return `select count(*)::bigint as present from supabase_migrations.schema_migrations where version = '${version}'`;
}

/**
 * Content-free projection identity: the row count and an order-independent id
 * digest. Only the count and digest leave the database; no id, text, vector or
 * URL is selected.
 */
export const PROJECTION_IDENTITY_SQL = `select
  count(*)::bigint as projection_id_count,
  md5(coalesce(string_agg(id::text, ',' order by id), '')) as projection_id_digest
from public.public_article_projection_p3`;

/** The re-used provenance audit counts query (counts only). */
export const PROVENANCE_COUNTS_SQL = SEMANTIC_PROVENANCE_AUDIT_SQL;

export interface ProjectionIdentity {
  count: number;
  digest: string;
}

function asCount(value: unknown): number {
  const parsed =
    typeof value === "number" && Number.isInteger(value)
      ? value
      : typeof value === "string" && /^\d+$/u.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("preflight returned a non-count value");
  return parsed;
}

/** Parses the live column rows, failing closed on a non-string column name. */
export function parseProjectionColumnRows(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => {
    const value = row.column_name;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("preflight returned a non-string projection column name");
    }
    return value;
  });
}

/** Parses the target-version presence probe. */
export function parseRemoteTargetVersionRow(row: Record<string, unknown>): boolean {
  return asCount(row.present) > 0;
}

/** Parses the content-free projection identity row. */
export function parseProjectionIdentityRow(row: Record<string, unknown>): ProjectionIdentity {
  const digest = row.projection_id_digest;
  if (typeof digest !== "string" || !/^[0-9a-f]{32}$/u.test(digest)) {
    throw new Error("preflight returned a malformed projection id digest");
  }
  return { count: asCount(row.projection_id_count), digest };
}

export interface ProvenanceCounts {
  currentPublishedRows: number;
  projectionRows: number;
  projectionEmbeddingNullCount: number;
  artifactBackedCurrentPublishedRows: number;
  legacyVersionEmbeddingOnlyCount: number;
  totalMismatchCount: number;
}

/** Projects the counts-only audit report into the camelCase rollout view. */
export function provenanceCountsFromAudit(report: SemanticProvenanceAuditReport): ProvenanceCounts {
  return {
    currentPublishedRows: report.counts.current_published_rows,
    projectionRows: report.counts.projection_rows,
    projectionEmbeddingNullCount: report.counts.projection_embedding_null_count,
    artifactBackedCurrentPublishedRows: report.counts.artifact_backed_current_published_rows,
    legacyVersionEmbeddingOnlyCount: report.counts.legacy_version_embedding_only_count,
    totalMismatchCount: report.totalMismatchCount,
  };
}

export const PROVENANCE_BASELINE_ERROR_CODES = [
  "provenance_mismatch",
  "projection_row_count_drift",
  "baseline_count_mismatch",
] as const;

export type ProvenanceBaselineErrorCode = (typeof PROVENANCE_BASELINE_ERROR_CODES)[number];

export interface ProvenanceBaselineBlocker {
  code: ProvenanceBaselineErrorCode;
  detail: string;
}

export interface ProvenanceBaselineEvaluation {
  ok: boolean;
  allowLiveBaseline: boolean;
  counts: ProvenanceCounts;
  blockers: ProvenanceBaselineBlocker[];
}

export interface EvaluateProvenanceBaselineOptions {
  /**
   * When true, the exact 1258/872 baseline is not required: the same-day current
   * counts are captured as-is, but every provenance mismatch must still be 0.
   */
  allowLiveBaseline?: boolean;
}

/**
 * Fails closed on the M7.7-A read-only baseline. In the default mode the counts
 * must equal the frozen plan baseline exactly; with `allowLiveBaseline` the
 * counts are captured live but all provider/model/dimensions/content_hash/version
 * mismatches must still be 0.
 */
export function evaluateProvenanceBaseline(
  counts: ProvenanceCounts,
  options: EvaluateProvenanceBaselineOptions = {},
): ProvenanceBaselineEvaluation {
  const allowLiveBaseline = options.allowLiveBaseline === true;
  const blockers: ProvenanceBaselineBlocker[] = [];
  if (counts.totalMismatchCount !== BASELINE_TOTAL_MISMATCH_COUNT) {
    blockers.push({
      code: "provenance_mismatch",
      detail: `provenance mismatch count must be 0, found ${counts.totalMismatchCount}`,
    });
  }
  if (counts.projectionRows !== counts.currentPublishedRows) {
    blockers.push({
      code: "projection_row_count_drift",
      detail: "the projection row count must equal the current published row count",
    });
  }
  if (!allowLiveBaseline) {
    const expected: Array<[keyof ProvenanceCounts, number]> = [
      ["currentPublishedRows", BASELINE_CURRENT_PUBLISHED_ROWS],
      ["projectionRows", BASELINE_PROJECTION_ROWS],
      ["artifactBackedCurrentPublishedRows", BASELINE_ARTIFACT_BACKED_CURRENT_PUBLISHED_ROWS],
      ["projectionEmbeddingNullCount", BASELINE_PROJECTION_EMBEDDING_NULL_COUNT],
      ["legacyVersionEmbeddingOnlyCount", BASELINE_LEGACY_VERSION_EMBEDDING_ONLY_COUNT],
    ];
    for (const [key, value] of expected) {
      if (counts[key] !== value) {
        blockers.push({
          code: "baseline_count_mismatch",
          detail: `${key} does not match the frozen plan baseline`,
        });
      }
    }
  }
  return { ok: blockers.length === 0, allowLiveBaseline, counts, blockers };
}

export const POST_APPLY_ERROR_CODES = [
  "columns_changed",
  "projection_embedding_null_nonzero",
  "projection_row_count_changed",
  "projection_id_digest_changed",
  "artifact_backed_mismatch",
  "provenance_mismatch",
  "smoke_oracle_drift",
] as const;

export type PostApplyErrorCode = (typeof POST_APPLY_ERROR_CODES)[number];

export interface PostApplyBlocker {
  code: PostApplyErrorCode;
  detail: string;
}

export interface PostApplyValidationInput {
  preColumns: readonly string[];
  postColumns: readonly string[];
  preIdentity: ProjectionIdentity;
  postIdentity: ProjectionIdentity;
  counts: ProvenanceCounts;
  smokeOracleDrift: number;
}

export interface PostApplyValidationResult {
  ok: boolean;
  blockers: PostApplyBlocker[];
}

/**
 * The M7.8-A post-apply validation contract. It fails closed unless: the live
 * column list/order is unchanged; every projection embedding is non-NULL; the
 * row count and content-free id digest are unchanged from the pre-apply capture;
 * artifact-backed = current published = projection; every provenance mismatch is
 * 0; and the bounded semantic/hybrid smoke oracle drift is 0.
 */
export function evaluatePostApplyValidation(input: PostApplyValidationInput): PostApplyValidationResult {
  const blockers: PostApplyBlocker[] = [];
  const columnsUnchanged =
    input.preColumns.length === input.postColumns.length &&
    input.preColumns.every((column, index) => column === input.postColumns[index]);
  if (!columnsUnchanged) {
    blockers.push({ code: "columns_changed", detail: "the projection column list/order changed after apply" });
  }
  if (input.counts.projectionEmbeddingNullCount !== 0) {
    blockers.push({
      code: "projection_embedding_null_nonzero",
      detail: `projection embedding NULL count must be 0, found ${input.counts.projectionEmbeddingNullCount}`,
    });
  }
  if (input.preIdentity.count !== input.postIdentity.count) {
    blockers.push({ code: "projection_row_count_changed", detail: "the projection row count changed after apply" });
  }
  if (input.preIdentity.digest !== input.postIdentity.digest) {
    blockers.push({ code: "projection_id_digest_changed", detail: "the projection id digest changed after apply" });
  }
  const artifactBacked =
    input.counts.artifactBackedCurrentPublishedRows === input.counts.currentPublishedRows &&
    input.counts.currentPublishedRows === input.counts.projectionRows;
  if (!artifactBacked) {
    blockers.push({
      code: "artifact_backed_mismatch",
      detail: "artifact-backed, current published and projection row counts must be equal after apply",
    });
  }
  if (input.counts.totalMismatchCount !== 0) {
    blockers.push({
      code: "provenance_mismatch",
      detail: `provenance mismatch count must be 0, found ${input.counts.totalMismatchCount}`,
    });
  }
  if (input.smokeOracleDrift !== 0) {
    blockers.push({
      code: "smoke_oracle_drift",
      detail: `semantic/hybrid smoke oracle drift must be 0, found ${input.smokeOracleDrift}`,
    });
  }
  return { ok: blockers.length === 0, blockers };
}

/** The pre-apply read-only checks, in the order the operator runs them. */
export const PREFLIGHT_CHECK_ORDER = [
  "linked_identity",
  "migration_sha256",
  "remote_target_absent",
  "pending_set_exact",
  "projection_columns",
  "provenance_baseline",
  "projection_identity",
] as const;

export type PreflightCheck = (typeof PREFLIGHT_CHECK_ORDER)[number];
