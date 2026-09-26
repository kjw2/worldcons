import type {
  SearchArticleTagRow,
  SearchBaseArticleRow,
  SearchProjectionDocumentRow,
  SearchProjectionFtsDocument,
  SearchProjectionParam,
  SearchPublicationP3Row,
  SearchTagRow,
  SearchVersionP3Row,
  SearchProjectionDocument,
} from "@/lib/cloudflare/search-projection";
import type {
  ArticleEmbeddingArtifactRow,
  VectorizeProjectionRecord,
  VectorProjectionBuildResult,
} from "@/lib/cloudflare/search-vector";

/**
 * M7.5 remote search materialization operator contract.
 *
 * Operator-only and dry-run by default. Supabase remains the sole search
 * authority; `worldcons_search` D1 and the `worldcons-search` Vectorize index
 * are disposable projections. Nothing here selects a runtime adapter, deploys a
 * Worker, changes a binding, or mutates a remote resource on its own: every
 * remote call is injected and every write is explicitly gated.
 */
export const SEARCH_MATERIALIZE_VERSION = 1 as const;
export const SEARCH_MATERIALIZE_STAGE = "d1-search-materialize" as const;

/** The only Cloudflare D1 database this operator may touch. */
export const SEARCH_MATERIALIZE_D1_DATABASE = "worldcons_search" as const;
/** The only Vectorize index this operator may touch. */
export const SEARCH_MATERIALIZE_VECTOR_INDEX = "worldcons-search" as const;
/** The only Vectorize dimensions/metric accepted for the target index. */
export const SEARCH_MATERIALIZE_VECTOR_DIMENSIONS = 1536 as const;
export const SEARCH_MATERIALIZE_VECTOR_METRIC = "cosine" as const;

/** Conservative bound on parameterized statements per D1 REST batch. */
export const SEARCH_MATERIALIZE_D1_BATCH_SIZE = 40;
/** Conservative bound on vectors per Vectorize NDJSON upsert batch. */
export const SEARCH_MATERIALIZE_VECTOR_UPSERT_BATCH_SIZE = 100;
/** Conservative bound on ids per Vectorize `delete_by_ids` call. */
export const SEARCH_MATERIALIZE_VECTOR_DELETE_BATCH_SIZE = 100;
/** Maximum mutation-polling time before the run fails closed. */
export const SEARCH_MATERIALIZE_VECTOR_MUTATION_TIMEOUT_MS = 120_000;
/** Mutation-polling interval. */
export const SEARCH_MATERIALIZE_VECTOR_MUTATION_POLL_MS = 2_000;
/** Maximum Vectorize list pages read before failing closed. */
export const SEARCH_MATERIALIZE_VECTOR_LIST_MAX_PAGES = 1_000;

/** The narrow source relations, keyed by their projection input name. */
export const SEARCH_SOURCE_RELATION_NAMES = [
  "publications",
  "versions",
  "articles",
  "tags",
  "articleTags",
  "artifacts",
] as const;
export type SearchSourceRelationName = (typeof SEARCH_SOURCE_RELATION_NAMES)[number];

/** Page-size defaults per source relation (small relations read wider pages). */
export const SEARCH_SOURCE_DEFAULT_PAGE_SIZE: Record<SearchSourceRelationName, number> = {
  publications: 25,
  versions: 25,
  articles: 200,
  tags: 200,
  articleTags: 200,
  artifacts: 25,
};

/** Safe per-relation row ceiling; exceeding it fails closed. */
export const SEARCH_SOURCE_DEFAULT_MAX_ROWS: Record<SearchSourceRelationName, number> = {
  publications: 100_000,
  versions: 100_000,
  articles: 100_000,
  tags: 100_000,
  articleTags: 500_000,
  artifacts: 100_000,
};

/**
 * The exact authored column projection per relation. `article_content_versions_p3`
 * deliberately omits `raw_text`, `search_vector` and `embedding`; the artifact
 * relation is the only reader of `embedding`. No full-table `*` projection is
 * ever issued.
 *
 * `compactColumns` is the stability probe re-read after the first pass. It MUST
 * cover every column the projection consumes (so a change to any projected field
 * between the two passes is detected), which here is exactly the full authored
 * column set. Relation identifiers and types are never parameters.
 */
export const SEARCH_SOURCE_RELATIONS: Record<
  SearchSourceRelationName,
  { relation: string; columns: readonly string[]; compactColumns: readonly string[]; orderBy: readonly string[] }
> = {
  publications: {
    relation: "article_publications_p3",
    columns: [
      "id",
      "article_id",
      "state",
      "version_id",
      "created_at",
      "updated_at",
      "published_at",
    ],
    compactColumns: ["id", "article_id", "state", "version_id", "created_at", "updated_at", "published_at"],
    orderBy: ["id"],
  },
  versions: {
    relation: "article_content_versions_p3",
    columns: [
      "id",
      "article_id",
      "source_key",
      "jurisdiction",
      "institution_name",
      "content_type",
      "original_language",
      "original_title",
      "korean_title",
      "original_published_at",
      "cleaned_text",
      "summary_json",
      "source_metadata",
      "case_key",
      "created_at",
      "fetched_at",
      "summarized_at",
      "content_hash",
    ],
    compactColumns: [
      "id",
      "article_id",
      "source_key",
      "jurisdiction",
      "institution_name",
      "content_type",
      "original_language",
      "original_title",
      "korean_title",
      "original_published_at",
      "cleaned_text",
      "summary_json",
      "source_metadata",
      "case_key",
      "created_at",
      "fetched_at",
      "summarized_at",
      "content_hash",
    ],
    orderBy: ["id"],
  },
  articles: {
    relation: "articles",
    columns: ["id", "review_state"],
    compactColumns: ["id", "review_state"],
    orderBy: ["id"],
  },
  tags: {
    relation: "tags",
    columns: ["id", "slug", "name", "normalized_name", "type"],
    compactColumns: ["id", "slug", "name", "normalized_name", "type"],
    orderBy: ["id"],
  },
  articleTags: {
    relation: "article_tags",
    columns: ["article_id", "tag_id"],
    compactColumns: ["article_id", "tag_id"],
    orderBy: ["article_id", "tag_id"],
  },
  artifacts: {
    relation: "article_embedding_artifacts",
    columns: [
      "article_version_id",
      "article_id",
      "content_hash",
      "provider",
      "model",
      "dimensions",
      "input_hash",
      "generated_at",
      "embedding",
    ],
    compactColumns: [
      "article_version_id",
      "article_id",
      "content_hash",
      "provider",
      "model",
      "dimensions",
      "input_hash",
      "generated_at",
      "embedding",
    ],
    orderBy: ["article_version_id"],
  },
};

export interface NarrowSearchSourceRows {
  publications: SearchPublicationP3Row[];
  versions: SearchVersionP3Row[];
  articles: SearchBaseArticleRow[];
  tags: SearchTagRow[];
  articleTags: SearchArticleTagRow[];
  artifacts: ArticleEmbeddingArtifactRow[];
}

export interface NarrowSearchSourceSnapshot {
  rows: NarrowSearchSourceRows;
  counts: Record<SearchSourceRelationName, number>;
  fingerprints: Record<SearchSourceRelationName, string>;
  /** Deterministic digest over every relation's compact tuples. */
  fingerprint: string;
  pageCount: number;
}

export interface BuildNarrowSearchSourceOptions {
  /** The reused Supabase linked-query boundary (a fake runner in tests). */
  runner: (sql: string) => Promise<string>;
  pageSize?: Partial<Record<SearchSourceRelationName, number>>;
  maxRows?: Partial<Record<SearchSourceRelationName, number>>;
  maxStdoutBytes?: number;
  timeoutMs?: number;
}

/** Compact current `search_documents` view used for planning (never full text). */
export interface D1CurrentState {
  documents: SearchProjectionDocumentRow[];
  documentCount: number;
  ftsArticleIds: string[];
  ftsCount: number;
}

export interface D1PlanReport {
  operation: "incremental";
  destructive: boolean;
  changes: { added: number; changed: number; removed: number; unchanged: number };
  statementCount: number;
  batchCount: number;
  batchSize: number;
}

export interface D1MaterializationResult {
  attempted: boolean;
  applied: boolean;
  verified: boolean;
  state: "dry-run" | "noop" | "applied" | "failed" | "rollback_required";
  current: { documentCount: number; ftsCount: number; documentChecksumHash: string; ftsIdHash: string };
  desired: { documentCount: number; ftsCount: number };
  plan: D1PlanReport | null;
  verification: { ok: boolean; issues: { code: string; articleId: string | null }[] } | null;
  snapshotPath: string | null;
  rollbackRequired: boolean;
  errors: string[];
}

/** One full pre-apply snapshot row; only persisted to the operator snapshot file. */
export type D1SnapshotRow = Record<string, SearchProjectionParam>;

export interface D1PreApplySnapshot {
  version: typeof SEARCH_MATERIALIZE_VERSION;
  stage: "search-materialize-d1-snapshot";
  database: typeof SEARCH_MATERIALIZE_D1_DATABASE;
  documents: D1SnapshotRow[];
  fts: D1SnapshotRow[];
}

export interface VectorizeIndexConfig {
  name: string;
  dimensions: number;
  metric: string;
}

export interface VectorizeMetadataIndexState {
  propertyName: string;
  type: string;
}

export interface VectorizePreflight {
  index: VectorizeIndexConfig | null;
  metadataIndexes: VectorizeMetadataIndexState[];
  vectorIds: string[];
  vectorCount: number;
}

export interface VectorizePlanReport {
  operation: "upsert" | "upsert+delete" | "none";
  upsertCount: number;
  deleteCount: number;
  upsertBatchCount: number;
  deleteBatchCount: number;
  upsertBatchSize: number;
  deleteBatchSize: number;
}

export interface VectorizeMaterializationResult {
  attempted: boolean;
  applied: boolean;
  verified: boolean;
  state: "skipped" | "dry-run" | "needs_provision" | "noop" | "applied" | "failed" | "refused";
  config: VectorizeIndexConfig | null;
  current: { vectorCount: number; idCount: number; idHash: string };
  desired: { recordCount: number; hash: string; missingCount: number; staleCount: number };
  metadataIndexes: {
    expected: { propertyName: string; type: string }[];
    present: string[];
    missing: string[];
    wrongType: { propertyName: string; expected: string; actual: string }[];
    created: string[];
  };
  plan: VectorizePlanReport | null;
  mutationIds: string[];
  verification: {
    ok: boolean;
    idCount: number;
    vectorCount: number;
    metadataIndexesOk: boolean;
    dimensions: number | null;
    metric: string | null;
  } | null;
  errors: string[];
}

export interface SearchMaterializationGates {
  applyD1: boolean;
  confirmSearchDb: string | null;
  applyVector: boolean;
  provisionVectorIndex: boolean;
  confirmVectorIndex: string | null;
}

export interface SearchMaterializationDesired {
  search: { documentCount: number; hash: string };
  ftsDocumentCount: number;
  vector: { recordCount: number; hash: string; missingCount: number; staleCount: number };
}

/** Deterministic, safe report. No document text, URLs, embeddings or secrets. */
export interface SearchMaterializationReport {
  version: typeof SEARCH_MATERIALIZE_VERSION;
  stage: typeof SEARCH_MATERIALIZE_STAGE;
  dryRun: boolean;
  source: {
    counts: Record<SearchSourceRelationName, number>;
    publishedCount: number;
    fingerprint: string;
    pageCount: number;
  };
  desired: SearchMaterializationDesired;
  d1: D1MaterializationResult;
  vector: VectorizeMaterializationResult;
  omissions: { missingCount: number; staleCount: number };
  blockedBy: string[];
  ok: boolean;
  errors: string[];
}

/** The full desired projection the operator builds from one source snapshot. */
export interface SearchMaterializationProjection {
  search: {
    documents: SearchProjectionDocument[];
    ftsDocuments: SearchProjectionFtsDocument[];
    manifest: { documentCount: number; hash: string; projectionVersion: number };
  };
  vector: VectorProjectionBuildResult;
  desired: SearchMaterializationDesired;
}

export type D1BatchStatement = { sql: string; params: SearchProjectionParam[] };
export type VectorizeRecord = VectorizeProjectionRecord;
