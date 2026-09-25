import { canonicalJson } from "@/lib/backfill/canonical-json";
import { shadowDigest } from "@/lib/cloudflare/d1/shadow/digest";
import {
  selectPublishedSearchProjectionSources,
  type SearchVersionP3Row,
  type SelectedSearchProjectionSource,
} from "@/lib/cloudflare/search-projection";
import { isIsoTimestamp, isLowercaseHex64, parseAndNormalizeEmbedding } from "./embedding";
import { vectorError } from "./errors";
import { buildVectorRecordMetadata } from "./metadata";
import {
  SEARCH_VECTOR_DIMENSIONS,
  SEARCH_VECTOR_INDEX_SCOPE,
  SEARCH_VECTOR_MODEL,
  SEARCH_VECTOR_PROJECTION_VERSION,
  SEARCH_VECTOR_PROVIDER,
  type ArticleEmbeddingArtifactRow,
  type VectorizeProjectionRecord,
  type VectorMutationPlan,
  type VectorMutationPlanChanges,
  type VectorMutationPlanSummary,
  type VectorProjectionBuildResult,
  type VectorProjectionManifest,
  type VectorProjectionOmission,
  type VectorProjectionSourceInput,
} from "./types";

/**
 * M7.4 Vectorize projection + provenance-locked mutation planning (code only).
 *
 * Records are built ONLY for a current published P3 source whose
 * `article_embedding_artifacts` row matches ALL of: version id, article id,
 * content hash, provider = gemini, model = gemini-embedding-001, dimensions =
 * 1536, a 64-lowercase-hex input hash, a 1536 finite embedding and a valid ISO
 * `generated_at`. A missing artifact omits the article and is reported; a
 * duplicate or structurally malformed matching artifact fails closed. No remote
 * read or write and no schema migration happen here.
 */

interface TypedArtifact {
  row: ArticleEmbeddingArtifactRow;
  articleVersionId: string;
  articleId: string;
  contentHash: string;
  provider: string;
  model: string;
  dimensions: number;
  inputHash: string;
  generatedAt: string;
}

function requireNonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw vectorError("invalid_artifact", `artifact ${field} must be a non-blank string`);
  }
  return value;
}

/** Presence/type-only structural validation; provenance matching happens later. */
function typeArtifact(row: ArticleEmbeddingArtifactRow): TypedArtifact {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw vectorError("invalid_artifact", "artifact row must be an object");
  }
  const dimensions = row.dimensions;
  if (typeof dimensions !== "number" || !Number.isInteger(dimensions) || dimensions <= 0) {
    throw vectorError("invalid_artifact", "artifact dimensions must be a positive integer");
  }
  const generatedAt = requireNonBlankString(row.generated_at, "generated_at");
  if (!isIsoTimestamp(generatedAt)) {
    throw vectorError("invalid_artifact", "artifact generated_at must be a valid ISO-8601 timestamp");
  }
  return {
    row,
    articleVersionId: requireNonBlankString(row.article_version_id, "article_version_id"),
    articleId: requireNonBlankString(row.article_id, "article_id"),
    contentHash: requireNonBlankString(row.content_hash, "content_hash"),
    provider: requireNonBlankString(row.provider, "provider"),
    model: requireNonBlankString(row.model, "model"),
    dimensions,
    inputHash: requireNonBlankString(row.input_hash, "input_hash"),
    generatedAt,
  };
}

/** True when every provenance field matches the selected published version. */
function provenanceMismatch(version: SearchVersionP3Row, artifact: TypedArtifact): string | null {
  if (artifact.articleId !== version.article_id) return "article_id";
  if (!isLowercaseHex64(version.content_hash) || artifact.contentHash !== version.content_hash) return "content_hash";
  if (artifact.provider !== SEARCH_VECTOR_PROVIDER) return "provider";
  if (artifact.model !== SEARCH_VECTOR_MODEL) return "model";
  if (artifact.dimensions !== SEARCH_VECTOR_DIMENSIONS) return "dimensions";
  if (!isLowercaseHex64(artifact.inputHash)) return "input_hash";
  return null;
}

/** Stable identity/provenance fingerprint (includes a vector digest; no crypto). */
export function vectorRecordFingerprint(record: Pick<VectorizeProjectionRecord, "metadata" | "values">): string {
  return shadowDigest(
    canonicalJson({
      metadata: record.metadata,
      values: record.values,
    }),
  );
}

function buildRecord(version: SearchVersionP3Row, artifact: TypedArtifact): VectorizeProjectionRecord {
  const values = parseAndNormalizeEmbedding(artifact.row.embedding, "invalid_artifact", "artifact embedding");
  const metadata = buildVectorRecordMetadata({
    sourceKey: version.source_key,
    jurisdiction: version.jurisdiction,
    contentType: version.content_type,
    language: version.original_language,
    originalPublishedAt: version.original_published_at,
    articleVersionId: version.id,
    contentHash: version.content_hash as string,
    provider: artifact.provider,
    model: artifact.model,
    dimensions: artifact.dimensions,
    inputHash: artifact.inputHash,
    generatedAt: artifact.generatedAt,
  });
  const record: VectorizeProjectionRecord = {
    id: version.article_id,
    values,
    metadata,
    fingerprint: "",
  };
  record.fingerprint = vectorRecordFingerprint(record);
  return record;
}

function indexArtifactsByVersion(
  artifacts: readonly ArticleEmbeddingArtifactRow[],
): Map<string, TypedArtifact> {
  const byVersion = new Map<string, TypedArtifact>();
  for (const row of artifacts) {
    const typed = typeArtifact(row);
    if (byVersion.has(typed.articleVersionId)) {
      throw vectorError(
        "duplicate_artifact",
        `duplicate article_embedding_artifacts for article_version_id ${typed.articleVersionId}`,
      );
    }
    byVersion.set(typed.articleVersionId, typed);
  }
  return byVersion;
}

function sortVectorProjectionRecords(records: readonly VectorizeProjectionRecord[]): VectorizeProjectionRecord[] {
  return [...records].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function indexUniqueRecords(
  records: readonly VectorizeProjectionRecord[],
  label: string,
): Map<string, VectorizeProjectionRecord> {
  const byId = new Map<string, VectorizeProjectionRecord>();
  for (const record of records) {
    if (byId.has(record.id)) {
      throw vectorError("duplicate_vector_id", `${label} contains duplicate Vectorize id ${record.id}`);
    }
    byId.set(record.id, record);
  }
  return byId;
}

/**
 * Builds the deterministic Vectorize projection. Published sources are selected
 * exactly like M7.1 (fail-closed P3 authority); each selected version is paired
 * with its current artifact or reported as an omission.
 */
export function buildVectorProjection(input: VectorProjectionSourceInput): VectorProjectionBuildResult {
  const artifactsByVersion = indexArtifactsByVersion(input.artifacts ?? []);
  const sources: SelectedSearchProjectionSource[] = selectPublishedSearchProjectionSources({
    publications: input.publications ?? [],
    versions: input.versions ?? [],
    articles: input.articles ?? [],
    tags: input.tags ?? [],
    articleTags: input.articleTags ?? [],
  });

  const records: VectorizeProjectionRecord[] = [];
  const omissions: VectorProjectionOmission[] = [];

  for (const source of sources) {
    const version = source.version;
    const artifact = artifactsByVersion.get(version.id);
    if (!artifact) {
      omissions.push({
        articleId: version.article_id,
        articleVersionId: version.id,
        reason: "missing_artifact",
        detail: "no article_embedding_artifacts row for the current published version",
      });
      continue;
    }
    const mismatch = provenanceMismatch(version, artifact);
    if (mismatch !== null) {
      omissions.push({
        articleId: version.article_id,
        articleVersionId: version.id,
        reason: "stale_artifact",
        detail: `artifact ${mismatch} does not match the current published version`,
      });
      continue;
    }
    records.push(buildRecord(version, artifact));
  }

  const sorted = sortVectorProjectionRecords(records);
  indexUniqueRecords(sorted, "vector projection");

  return {
    records: sorted,
    omissions: omissions.sort((left, right) => (left.articleId < right.articleId ? -1 : left.articleId > right.articleId ? 1 : 0)),
    manifest: vectorProjectionManifest(sorted, omissions),
  };
}

/** Deterministic count/hash manifest; no vector values or content text. */
export function vectorProjectionManifest(
  records: readonly VectorizeProjectionRecord[],
  omissions: readonly VectorProjectionOmission[] = [],
): VectorProjectionManifest {
  const sorted = sortVectorProjectionRecords(records);
  const missingCount = omissions.filter((entry) => entry.reason === "missing_artifact").length;
  const staleCount = omissions.filter((entry) => entry.reason === "stale_artifact").length;
  return {
    version: 1,
    scope: SEARCH_VECTOR_INDEX_SCOPE,
    recordCount: sorted.length,
    projectionVersion: SEARCH_VECTOR_PROJECTION_VERSION,
    hash: shadowDigest(
      canonicalJson(sorted.map((record) => ({ id: record.id, fingerprint: record.fingerprint }))),
    ),
    missingCount,
    staleCount,
  };
}

function planChanges(partial: Partial<VectorMutationPlanChanges>): VectorMutationPlanChanges {
  return { added: 0, changed: 0, removed: 0, unchanged: 0, ...partial };
}

/**
 * Full projection: upsert the entire desired record set. There is deliberately
 * no delete-all intent because the structural Vectorize binding cannot list
 * arbitrary current IDs, so stale removal is only expressible as the incremental
 * plan against an observed current set. Never executed here.
 */
export function planVectorFullProjection(records: readonly VectorizeProjectionRecord[]): VectorMutationPlan {
  const sorted = sortVectorProjectionRecords(records);
  indexUniqueRecords(sorted, "full-projection input");
  return {
    scope: SEARCH_VECTOR_INDEX_SCOPE,
    operation: "full-projection",
    destructive: false,
    atomic: false,
    executionDeferred: true,
    noop: sorted.length === 0,
    changes: planChanges({ added: sorted.length }),
    upserts: sorted,
    deletes: [],
  };
}

/**
 * Deterministic incremental plan from the current materialized records to the
 * next desired records. A record is `changed` when its identity/provenance/
 * vector fingerprint differs, so a version/content-hash/input-hash/model change
 * forces an upsert. Removed IDs become deletes so no stale vector survives.
 * Identical input is a true no-op. Never executed here.
 */
export function planVectorIncrementalSync(
  current: readonly VectorizeProjectionRecord[],
  next: readonly VectorizeProjectionRecord[],
): VectorMutationPlan {
  const currentById = indexUniqueRecords(current, "current");
  const nextById = indexUniqueRecords(next, "next");

  const removed = [...currentById.keys()].filter((id) => !nextById.has(id)).sort();
  const added = [...nextById.keys()].filter((id) => !currentById.has(id)).sort();
  const changed = [...nextById.keys()]
    .filter((id) => {
      const previous = currentById.get(id);
      if (previous === undefined) return false;
      return vectorRecordFingerprint(previous) !== vectorRecordFingerprint(nextById.get(id)!);
    })
    .sort();

  const upsertIds = [...added, ...changed].sort();
  const upserts = upsertIds.map((id) => nextById.get(id)!);
  const unchanged = nextById.size - added.length - changed.length;

  return {
    scope: SEARCH_VECTOR_INDEX_SCOPE,
    operation: "incremental",
    destructive: removed.length > 0,
    atomic: false,
    executionDeferred: true,
    noop: upserts.length === 0 && removed.length === 0,
    changes: planChanges({ added: added.length, changed: changed.length, removed: removed.length, unchanged }),
    upserts,
    deletes: removed,
  };
}

/** Safe operator view: ids/counts/provenance only; NEVER vector values. */
export function vectorMutationPlanSummary(plan: VectorMutationPlan): VectorMutationPlanSummary {
  return {
    scope: plan.scope,
    operation: plan.operation,
    destructive: plan.destructive,
    atomic: plan.atomic,
    executionDeferred: plan.executionDeferred,
    noop: plan.noop,
    changes: plan.changes,
    upsertCount: plan.upserts.length,
    deleteCount: plan.deletes.length,
    upserts: plan.upserts.map((record) => ({
      id: record.id,
      articleVersionId: record.metadata.articleVersionId,
      contentHash: record.metadata.contentHash,
      provider: record.metadata.provider,
      model: record.metadata.model,
      dimensions: record.metadata.dimensions,
      inputHash: record.metadata.inputHash,
      generatedAt: record.metadata.generatedAt,
      projectionVersion: record.metadata.projectionVersion,
    })),
    deletes: [...plan.deletes],
  };
}
