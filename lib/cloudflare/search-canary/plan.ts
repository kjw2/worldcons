import {
  buildSearchProjection,
  searchProjectionManifest,
  type SearchProjectionBuildResult,
  type SearchProjectionDocument,
  type SearchProjectionFtsDocument,
  type SearchProjectionSourceInput,
} from "@/lib/cloudflare/search-projection";
import {
  buildVectorProjection,
  vectorProjectionManifest,
  type ArticleEmbeddingArtifactRow,
  type VectorProjectionOmission,
} from "@/lib/cloudflare/search-vector";
import {
  SEARCH_CANARY_MAX_ARTICLES_CEILING,
  SEARCH_CANARY_MAX_ARTICLES_DEFAULT,
  type SearchCanaryBlocker,
  type SearchCanaryProjectionPlan,
} from "./types";

/**
 * Bounded, deterministic canary projection planning (runtime-neutral).
 *
 * The full authoritative projection is derived exactly like M7.1/M7.4 (so P3
 * authority, provenance locks and fail-closed behavior are unchanged), then
 * deterministically truncated to the first `maxArticles` article ids. Bounding
 * happens AFTER authority selection so a canary never changes which documents
 * are considered authoritative; it only limits how many are materialized.
 */
export interface BuildSearchCanaryProjectionPlanInput extends SearchProjectionSourceInput {
  artifacts: readonly ArticleEmbeddingArtifactRow[];
  maxArticles?: number;
}

function bound(maxArticles: number | undefined): number {
  const value = maxArticles ?? SEARCH_CANARY_MAX_ARTICLES_DEFAULT;
  if (!Number.isInteger(value) || value <= 0) throw new Error("maxArticles must be a positive integer");
  if (value > SEARCH_CANARY_MAX_ARTICLES_CEILING) {
    throw new Error(`maxArticles must not exceed ${SEARCH_CANARY_MAX_ARTICLES_CEILING}`);
  }
  return value;
}

function boundSearchProjection(
  built: SearchProjectionBuildResult,
  selectedIds: ReadonlySet<string>,
): { documents: SearchProjectionDocument[]; ftsDocuments: SearchProjectionFtsDocument[] } {
  const ftsById = new Map(built.ftsDocuments.map((fts) => [fts.article_id, fts]));
  const documents = built.documents.filter((document) => selectedIds.has(document.article_id));
  const ftsDocuments = documents.map((document) => ftsById.get(document.article_id)!);
  return { documents, ftsDocuments };
}

export interface SearchCanaryProjectionPlanResult extends SearchCanaryProjectionPlan {
  ftsDocuments: SearchProjectionFtsDocument[];
  omissions: VectorProjectionOmission[];
  /** Full authoritative document count before bounding (for truncation evidence). */
  fullDocumentCount: number;
  fullRecordCount: number;
}

export function buildSearchCanaryProjectionPlan(
  input: BuildSearchCanaryProjectionPlanInput,
): SearchCanaryProjectionPlanResult {
  const maxArticles = bound(input.maxArticles);
  const blockers: SearchCanaryBlocker[] = [];

  const built = buildSearchProjection({
    publications: input.publications,
    versions: input.versions,
    articles: input.articles,
    tags: input.tags,
    articleTags: input.articleTags,
    gate2Eligibility: input.gate2Eligibility,
  });
  const vectorBuilt = buildVectorProjection({
    publications: input.publications,
    versions: input.versions,
    articles: input.articles,
    tags: input.tags,
    articleTags: input.articleTags,
    artifacts: input.artifacts,
    gate2Eligibility: input.gate2Eligibility,
  });

  const selectedIds = new Set(built.documents.slice(0, maxArticles).map((document) => document.article_id));
  const boundedSearch = boundSearchProjection(built, selectedIds);
  const records = vectorBuilt.records.filter((record) => selectedIds.has(record.id));
  const omissions = vectorBuilt.omissions.filter((omission) => selectedIds.has(omission.articleId));
  const truncated = built.documents.length > boundedSearch.documents.length || vectorBuilt.records.length > records.length;

  return {
    version: 1,
    maxArticles,
    truncated,
    documents: boundedSearch.documents,
    ftsDocuments: boundedSearch.ftsDocuments,
    records,
    omissions,
    changes: {
      projectedDocuments: boundedSearch.documents.length,
      vectorRecords: records.length,
      missingArtifacts: omissions.filter((omission) => omission.reason === "missing_artifact").length,
      staleArtifacts: omissions.filter((omission) => omission.reason === "stale_artifact").length,
    },
    blockers,
    manifest: {
      searchHash: searchProjectionManifest(boundedSearch.documents).hash,
      vectorHash: vectorProjectionManifest(records).hash,
    },
    fullDocumentCount: built.documents.length,
    fullRecordCount: vectorBuilt.records.length,
  };
}
