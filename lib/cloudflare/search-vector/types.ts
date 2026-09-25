import type { SearchProjectionSourceInput } from "@/lib/cloudflare/search-projection";
import type { RankedSearchPagePayload, RankedSearchResolvedRequest } from "@/lib/cloudflare/search-ranked";

/**
 * M7.4 Vectorize semantic + hybrid LOCAL foundation types.
 *
 * Runtime-neutral: no `@cloudflare`/`node:*` import, no adapter selection and no
 * remote read/write. Supabase remains the sole production search authority.
 * This module only models the documented (2026-09-25) Vectorize V2 constraints:
 * 1536 float32 dimensions, topK <= 100 for `returnValues:false` +
 * `returnMetadata:indexed`, metadata filter applied before nearest-neighbor
 * topK, <= 10 metadata indexes and string/number/boolean scalar metadata. String
 * array metadata is intentionally never indexed or filtered.
 */

/** The Vectorize index the local projection targets (`worldcons-search` plan). */
export const SEARCH_VECTOR_INDEX_SCOPE = "worldcons-search" as const;

/** Authored projection version stored on every record and metadata. */
export const SEARCH_VECTOR_PROJECTION_VERSION = 1 as const;

/** Gemini-only embedding provenance (mirrors the migration constraints). */
export const SEARCH_VECTOR_PROVIDER = "gemini" as const;
export const SEARCH_VECTOR_MODEL = "gemini-embedding-001" as const;
export const SEARCH_VECTOR_DIMENSIONS = 1536 as const;

/** Documented Vectorize V2 limits used by this foundation. */
export const VECTORIZE_MAX_DIMENSIONS = 1536 as const;
export const VECTORIZE_QUERY_MAX_TOPK = 100 as const;
export const VECTORIZE_MAX_METADATA_INDEXES = 10 as const;
export const VECTORIZE_VECTOR_ID_MAX_BYTES = 64 as const;

/** UTF-8 bytes of an indexed string metadata value that remain filterable. */
export const VECTORIZE_INDEXED_STRING_PREFIX_BYTES = 64 as const;

/**
 * The recommended METADATA INDEX manifest (code/docs only; no remote creation).
 *
 * `sourceKey:string`, `jurisdiction:string`, `contentType:string`,
 * `language:string`, `publishedEpoch:number`. That is 5 of the maximum 10
 * metadata indexes. Tag is intentionally excluded: array metadata cannot be
 * indexed/filtered and a document can carry multiple tags, so an exact `p_tag`
 * filter is deferred rather than approximated.
 */
export const VECTOR_METADATA_INDEX_FIELDS = [
  "sourceKey",
  "jurisdiction",
  "contentType",
  "language",
  "publishedEpoch",
] as const;

export type VectorMetadataIndexField = (typeof VECTOR_METADATA_INDEX_FIELDS)[number];

export interface VectorMetadataIndexDefinition {
  propertyName: VectorMetadataIndexField;
  type: "string" | "number";
}

export const VECTOR_METADATA_INDEX_MANIFEST: readonly VectorMetadataIndexDefinition[] = [
  { propertyName: "sourceKey", type: "string" },
  { propertyName: "jurisdiction", type: "string" },
  { propertyName: "contentType", type: "string" },
  { propertyName: "language", type: "string" },
  { propertyName: "publishedEpoch", type: "number" },
];

/**
 * One raw `article_embedding_artifacts` row as read from D1/PostgREST. Every
 * field is `unknown` because the row is untrusted input validated fail-closed.
 * `embedding` may arrive as a `number[]` or a pgvector/JSON text value.
 */
export interface ArticleEmbeddingArtifactRow {
  article_version_id: unknown;
  article_id: unknown;
  content_hash: unknown;
  provider: unknown;
  model: unknown;
  dimensions: unknown;
  input_hash: unknown;
  embedding: unknown;
  generated_at: unknown;
  updated_at?: unknown;
}

/**
 * Vector projection input: the same authoritative P3 publication/version source
 * as M7.1 (published `article_publications_p3` joined to
 * `article_content_versions_p3`) plus the embedding artifacts. The version rows
 * must carry `content_hash` (M7.4 additive field).
 */
export interface VectorProjectionSourceInput extends SearchProjectionSourceInput {
  artifacts: readonly ArticleEmbeddingArtifactRow[];
}

/** Scalar vector metadata accepted by Vectorize. Null/blank values are omitted. */
export type VectorizeMetadataValue = string | number | boolean;

/**
 * Provenance + query-filter metadata stored on every Vectorize record. Optional
 * scalar fields are omitted entirely when null/blank; a fake string is never
 * encoded. `articleVersionId`/`contentHash`/`provider`/`model`/`dimensions`/
 * `inputHash`/`generatedAt`/`projectionVersion` are the provenance tuple.
 */
export interface VectorizeRecordMetadata {
  sourceKey?: string;
  jurisdiction?: string;
  contentType?: string;
  language?: string;
  /** `original_published_at` as epoch milliseconds; omitted when unparseable. */
  publishedEpoch?: number;
  articleVersionId: string;
  contentHash: string;
  provider: string;
  model: string;
  dimensions: number;
  inputHash: string;
  generatedAt: string;
  projectionVersion: number;
}

/** A Vectorize record the local projection can upsert (id == article_id). */
export interface VectorizeProjectionRecord {
  /** Stable Vectorize ID: the article UUID (well under the 64-byte limit). */
  id: string;
  /** Normalized, finite, 1536-d values (unit length). Never emitted in summaries. */
  values: number[];
  metadata: VectorizeRecordMetadata;
  /** Deterministic change-detection fingerprint (includes a vector digest). */
  fingerprint: string;
}

export type VectorProjectionOmissionReason = "missing_artifact" | "stale_artifact";

/** Evidence for one published article that produced no vector record. */
export interface VectorProjectionOmission {
  articleId: string;
  articleVersionId: string;
  reason: VectorProjectionOmissionReason;
  detail: string;
}

/** Deterministic count/hash manifest (no vector values, no content text). */
export interface VectorProjectionManifest {
  version: 1;
  scope: typeof SEARCH_VECTOR_INDEX_SCOPE;
  recordCount: number;
  projectionVersion: number;
  hash: string;
  missingCount: number;
  staleCount: number;
}

export interface VectorProjectionBuildResult {
  records: VectorizeProjectionRecord[];
  omissions: VectorProjectionOmission[];
  manifest: VectorProjectionManifest;
}

export interface VectorMutationPlanChanges {
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
}

/**
 * A local, not-yet-executed mutation plan. `atomic` is always false because M7.4
 * never chooses or executes a remote Vectorize primitive; a later slice may
 * execute upserts/deletes after focused failure/rollback verification.
 */
export interface VectorMutationPlan {
  scope: typeof SEARCH_VECTOR_INDEX_SCOPE;
  operation: "full-projection" | "incremental";
  destructive: boolean;
  atomic: false;
  executionDeferred: true;
  noop: boolean;
  changes: VectorMutationPlanChanges;
  upserts: VectorizeProjectionRecord[];
  deletes: string[];
}

/** Safe operator view: ids, counts and provenance only; NEVER vector values. */
export interface VectorMutationPlanSummary {
  scope: typeof SEARCH_VECTOR_INDEX_SCOPE;
  operation: "full-projection" | "incremental";
  destructive: boolean;
  atomic: false;
  executionDeferred: true;
  noop: boolean;
  changes: VectorMutationPlanChanges;
  upsertCount: number;
  deleteCount: number;
  upserts: {
    id: string;
    articleVersionId: string;
    contentHash: string;
    provider: string;
    model: string;
    dimensions: number;
    inputHash: string;
    generatedAt: string;
    projectionVersion: number;
  }[];
  deletes: string[];
}

/** One indexed scalar metadata condition (Vectorize V2 filter shape subset). */
export interface VectorizeMetadataCondition {
  $eq?: VectorizeMetadataValue;
  $ne?: VectorizeMetadataValue;
  $gt?: VectorizeMetadataValue;
  $gte?: VectorizeMetadataValue;
  $lt?: VectorizeMetadataValue;
  $lte?: VectorizeMetadataValue;
  $in?: readonly VectorizeMetadataValue[];
  $nin?: readonly VectorizeMetadataValue[];
}

/** Vectorize metadata filter: scalar shorthand or a condition object per field. */
export type VectorizeMetadataFilter = Record<string, VectorizeMetadataValue | VectorizeMetadataCondition>;

/**
 * Structural Vectorize index binding matching current Worker usage. No
 * `@cloudflare` type import is required; the Worker passes its real binding and
 * local tests pass a deterministic in-memory fake.
 */
export interface VectorizeQueryOptions {
  topK: number;
  /**
   * Optional metadata pre-filter. It is OMITTED (never `null`/`{}`) when the
   * request constrains nothing, because Vectorize requires a non-empty filter
   * object and the structural binding must match real Worker usage.
   */
  filter?: VectorizeMetadataFilter;
  returnValues?: false;
  returnMetadata?: "none" | "indexed" | "all";
}

export interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown> | null;
}

export interface VectorizeQueryResult {
  count?: number;
  matches: VectorizeMatch[];
}

export interface VectorizeIndexBinding {
  query(vector: readonly number[], options: VectorizeQueryOptions): Promise<VectorizeQueryResult>;
}

/** The authoring shape of a `worldcons_ranked_search_page_v1` payload entry. */
export type RankedVectorSearchPayload = RankedSearchPagePayload;

export type { RankedSearchResolvedRequest };

/** Resolved semantic/hybrid window (computed from the RPC's own formula). */
export interface VectorPageWindow {
  /** Vectorize `topK` for the semantic branch / each hybrid candidate list. */
  topK: number;
  /** RPC hybrid `v_candidate_limit = min(max((offset+limit+1)*3, 100), 30063)`. */
  candidateLimit: number;
  /** The RPC hybrid candidate-limit ceiling (`30063`). */
  candidateCeiling: number;
}

/**
 * One validated semantic Vectorize query plan. `filter` is `null` (omitted) when
 * the request has no scalar/range constraint, because Vectorize rejects an empty
 * filter object.
 */
export interface SemanticVectorQueryPlan {
  topK: number;
  filter: VectorizeMetadataFilter | null;
}

/** One D1 metadata row used to enrich Vectorize/FTS hybrid candidates. */
export interface HybridCandidateMetadataRow {
  article_id: string;
  title: string;
  original_published_at: string | null;
}
