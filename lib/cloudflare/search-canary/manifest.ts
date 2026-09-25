import {
  SEARCH_VECTOR_DIMENSIONS,
  VECTOR_METADATA_INDEX_MANIFEST,
  VECTORIZE_MAX_METADATA_INDEXES,
} from "@/lib/cloudflare/search-vector";
import {
  SEARCH_CANARY_VECTOR_INDEX,
  type SearchCanaryBlocker,
  type SearchCanaryVectorBootstrapPlan,
  type SearchCanaryVectorIndexState,
} from "./types";

/**
 * Pure, idempotent Vectorize bootstrap planning for the isolated M7.5 canary
 * index. The plan only ever CREATEs a missing index or a missing metadata index;
 * it never deletes or replaces anything. An existing canary index with the wrong
 * dimensions or metric fails closed with a recorded blocker and no action, so a
 * pre-existing (or misnamed) production index can never be mutated.
 */
export interface PlanSearchCanaryVectorBootstrapInput {
  indexName?: string;
  dimensions?: number;
  existingIndex?: SearchCanaryVectorIndexState | null;
  /** Property names on which metadata filtering is already enabled. */
  existingMetadataIndexes?: readonly string[];
}

export function planSearchCanaryVectorBootstrap(
  input: PlanSearchCanaryVectorBootstrapInput = {},
): SearchCanaryVectorBootstrapPlan {
  const indexName = input.indexName ?? SEARCH_CANARY_VECTOR_INDEX;
  const dimensions = input.dimensions ?? SEARCH_VECTOR_DIMENSIONS;
  const existingIndex = input.existingIndex ?? null;
  const existingMetadata = new Set(input.existingMetadataIndexes ?? []);
  const blockers: SearchCanaryBlocker[] = [];

  const exists = existingIndex?.exists === true;
  let indexAction: "none" | "create" = exists ? "none" : "create";

  if (exists) {
    const dimensionMismatch = existingIndex?.dimensions !== dimensions;
    const metricMismatch = existingIndex?.metric !== null && existingIndex?.metric !== "cosine";
    if (dimensionMismatch || metricMismatch) {
      blockers.push({
        code: "canary_index_mismatch",
        detail: `canary index ${indexName} exists with dimensions=${String(existingIndex?.dimensions)} metric=${String(
          existingIndex?.metric,
        )}; refusing to modify an existing index`,
      });
      indexAction = "none";
    }
  }

  const metadataIndexes = VECTOR_METADATA_INDEX_MANIFEST.map((definition) => ({
    propertyName: definition.propertyName,
    type: definition.type,
    exists: existingMetadata.has(definition.propertyName),
    action: existingMetadata.has(definition.propertyName) ? ("none" as const) : ("create" as const),
  }));

  const missingMetadata = metadataIndexes.filter((entry) => entry.action === "create").length;
  if (existingMetadata.size + missingMetadata > VECTORIZE_MAX_METADATA_INDEXES) {
    blockers.push({
      code: "canary_metadata_index_capacity",
      detail: `canary index ${indexName} would exceed the ${VECTORIZE_MAX_METADATA_INDEXES}-metadata-index ceiling`,
    });
  }

  const ok = blockers.every((blocker) => blocker.code !== "canary_index_mismatch" && blocker.code !== "canary_metadata_index_capacity");

  return {
    version: 1,
    index: {
      name: indexName,
      exists,
      dimensions,
      metric: "cosine",
      action: indexAction,
    },
    metadataIndexes,
    blockers,
    destructive: false,
    ok,
  };
}
