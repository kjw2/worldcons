/**
 * M7.7-A read-only semantic provenance audit (pure, runtime-neutral).
 *
 * This module authors ONE read-only observation query over the linked Supabase
 * schema and maps its single result row to counts. It selects no vector value,
 * no article text, no summary, no URL and no article/version id: every projected
 * column is a `count(...)` or a boolean predicate collapse. The operator script
 * (`scripts/semantic-provenance-audit.ts`) is the only place that wires this to
 * the child-process Supabase CLI, and it has no `--apply` path.
 *
 * The audit exists to size the M7.7-A semantic authority drift without mutating
 * Supabase: how many current published P3 rows carry a provenance-locked Gemini
 * artifact, how many projection embeddings are still NULL, how many are backed
 * only by the legacy `v.embedding`, and how many artifacts disagree on
 * provider/model/dimensions/content_hash/version.
 */

export const SEMANTIC_PROVENANCE_AUDIT_COUNT_COLUMNS = [
  "current_published_rows",
  "projection_rows",
  "projection_embedding_null_count",
  "artifact_backed_current_published_rows",
  "legacy_version_embedding_only_count",
  "artifact_provider_mismatch_count",
  "artifact_model_mismatch_count",
  "artifact_dimensions_mismatch_count",
  "artifact_content_hash_mismatch_count",
  "artifact_version_mismatch_count",
] as const;

export type SemanticProvenanceAuditCountColumn = (typeof SEMANTIC_PROVENANCE_AUDIT_COUNT_COLUMNS)[number];

export interface SemanticProvenanceAuditReport {
  version: 1;
  /** Counts only; never a vector, text, URL or id. */
  counts: Record<SemanticProvenanceAuditCountColumn, number>;
  /** Sum of provider/model/dimensions/content_hash/version mismatches. */
  totalMismatchCount: number;
}

/**
 * One read-only statement. `current_published` is the published
 * `article_publications_p3` join to `article_content_versions_p3`; the view count
 * reads the currently deployed `public_article_projection_p3` as-is, so the
 * audit is valid before and after the M7.7-A migration is applied remotely.
 */
export const SEMANTIC_PROVENANCE_AUDIT_SQL = `with current_published as (
  select
    p.article_id as article_id,
    p.version_id as version_id,
    v.content_hash as content_hash,
    (v.embedding is not null) as has_version_embedding
  from public.article_publications_p3 p
  join public.article_content_versions_p3 v
    on v.id = p.version_id and v.article_id = p.article_id
  where p.state = 'published'
),
artifact_by_article as (
  select
    cp.article_id, cp.version_id, cp.content_hash as version_content_hash,
    cp.has_version_embedding,
    e.article_version_id as artifact_version_id,
    e.provider as provider, e.model as model, e.dimensions as dimensions,
    e.content_hash as artifact_content_hash
  from current_published cp
  join public.article_embedding_artifacts e on e.article_id = cp.article_id
)
select
  (select count(*) from current_published)::bigint as current_published_rows,
  (select count(*) from public.public_article_projection_p3)::bigint as projection_rows,
  (select count(*) from public.public_article_projection_p3 where embedding is null)::bigint as projection_embedding_null_count,
  (select count(*) from current_published cp where exists(
    select 1 from public.article_embedding_artifacts e
    where e.article_version_id = cp.version_id
      and e.article_id = cp.article_id
      and e.content_hash = cp.content_hash
      and e.provider = 'gemini'
      and e.model = 'gemini-embedding-001'
      and e.dimensions = 1536
  ))::bigint as artifact_backed_current_published_rows,
  (select count(*) from current_published cp where cp.has_version_embedding = false and exists(
    select 1 from public.article_embedding_artifacts e
    where e.article_version_id = cp.version_id
      and e.article_id = cp.article_id
      and e.content_hash = cp.content_hash
      and e.provider = 'gemini'
      and e.model = 'gemini-embedding-001'
      and e.dimensions = 1536
  ))::bigint as legacy_version_embedding_only_count,
  (select count(*) from artifact_by_article where provider is distinct from 'gemini')::bigint as artifact_provider_mismatch_count,
  (select count(*) from artifact_by_article where model is distinct from 'gemini-embedding-001')::bigint as artifact_model_mismatch_count,
  (select count(*) from artifact_by_article where dimensions is distinct from 1536)::bigint as artifact_dimensions_mismatch_count,
  (select count(*) from artifact_by_article where artifact_content_hash is distinct from version_content_hash)::bigint as artifact_content_hash_mismatch_count,
  (select count(*) from artifact_by_article where artifact_version_id is distinct from version_id)::bigint as artifact_version_mismatch_count`;

const MISMATCH_COLUMNS = [
  "artifact_provider_mismatch_count",
  "artifact_model_mismatch_count",
  "artifact_dimensions_mismatch_count",
  "artifact_content_hash_mismatch_count",
  "artifact_version_mismatch_count",
] as const satisfies readonly SemanticProvenanceAuditCountColumn[];

function nonNegativeInteger(value: unknown, column: SemanticProvenanceAuditCountColumn): number {
  const parsed =
    typeof value === "number" && Number.isInteger(value)
      ? value
      : typeof value === "string" && /^\d+$/u.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`semantic provenance audit returned a non-count value for ${column}`);
  }
  return parsed;
}

/**
 * Maps one audit row to counts, failing closed on a missing or non-integer
 * column. It never echoes the offending value, so no unexpected payload can leak
 * into a log.
 */
export function parseSemanticProvenanceAuditRow(row: Record<string, unknown>): SemanticProvenanceAuditReport {
  const counts = {} as Record<SemanticProvenanceAuditCountColumn, number>;
  for (const column of SEMANTIC_PROVENANCE_AUDIT_COUNT_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(row, column)) {
      throw new Error(`semantic provenance audit row is missing ${column}`);
    }
    counts[column] = nonNegativeInteger(row[column], column);
  }
  const totalMismatchCount = MISMATCH_COLUMNS.reduce((total, column) => total + counts[column], 0);
  return { version: 1, counts, totalMismatchCount };
}
