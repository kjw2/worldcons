import { isNonBlankString, nullableTrim } from "@/lib/cloudflare/search-projection";
import { searchFtsRangeThresholdIso } from "@/lib/cloudflare/search-fts";
import type { RankedSearchResolvedRequest } from "@/lib/cloudflare/search-ranked";
import { epochMsFromIso } from "./embedding";
import { vectorError } from "./errors";
import {
  SEARCH_VECTOR_PROJECTION_VERSION,
  VECTOR_METADATA_INDEX_MANIFEST,
  type VectorizeMetadataFilter,
  type VectorizeRecordMetadata,
  type VectorMetadataIndexDefinition,
} from "./types";

/**
 * Runtime-neutral Vectorize metadata construction and filter building.
 *
 * Optional scalar metadata is OMITTED when null/blank; no fake placeholder string
 * is ever encoded. The filter only ever contains authored scalar fields, and the
 * UTC range threshold reuses the exact M7.2/M7.3 semantics
 * (`searchFtsRangeThresholdIso`), stored as an epoch-millisecond `$gte` on the
 * indexed `publishedEpoch` property so Vectorize applies it BEFORE topK.
 */

export function vectorMetadataIndexManifest(): readonly VectorMetadataIndexDefinition[] {
  return VECTOR_METADATA_INDEX_MANIFEST;
}

export interface VectorRecordMetadataInput {
  sourceKey: unknown;
  jurisdiction: unknown;
  contentType: unknown;
  language: unknown;
  originalPublishedAt: unknown;
  articleVersionId: string;
  contentHash: string;
  provider: string;
  model: string;
  dimensions: number;
  inputHash: string;
  generatedAt: string;
}

/** Builds deterministic metadata, omitting every null/blank optional scalar. */
export function buildVectorRecordMetadata(input: VectorRecordMetadataInput): VectorizeRecordMetadata {
  const metadata: VectorizeRecordMetadata = {
    articleVersionId: input.articleVersionId,
    contentHash: input.contentHash,
    provider: input.provider,
    model: input.model,
    dimensions: input.dimensions,
    inputHash: input.inputHash,
    generatedAt: new Date(Date.parse(input.generatedAt)).toISOString(),
    projectionVersion: SEARCH_VECTOR_PROJECTION_VERSION,
  };

  const sourceKey = nullableTrim(input.sourceKey);
  if (sourceKey !== null) metadata.sourceKey = sourceKey;
  const jurisdiction = nullableTrim(input.jurisdiction);
  if (jurisdiction !== null) metadata.jurisdiction = jurisdiction;
  const contentType = nullableTrim(input.contentType);
  if (contentType !== null) metadata.contentType = contentType;
  const language = nullableTrim(input.language);
  if (language !== null) metadata.language = language;

  const publishedEpoch = epochMsFromIso(isNonBlankString(input.originalPublishedAt) ? input.originalPublishedAt : null);
  if (publishedEpoch !== null) metadata.publishedEpoch = publishedEpoch;

  return metadata;
}

/**
 * Builds the Vectorize metadata pre-filter for a validated semantic/hybrid
 * request, or `null` when the request constrains nothing.
 *
 * Vectorize requires a NON-EMPTY `filter` object (`filter` must be non-empty
 * whose compact JSON representation is < 2048 bytes). Sending `{}` is rejected by
 * the API, so an unconstrained request (for example the default `latest` range
 * with no scalar filters) must omit the filter entirely rather than send an empty
 * object. `p_tag` is intentionally NOT handled here: the caller fails closed with
 * `tag_filter_deferred` before reaching a filter.
 */
export function buildVectorMetadataFilter(resolved: RankedSearchResolvedRequest): VectorizeMetadataFilter | null {
  const filter: VectorizeMetadataFilter = {};
  if (resolved.source !== null) filter.sourceKey = resolved.source;
  if (resolved.jurisdiction !== null) filter.jurisdiction = resolved.jurisdiction;
  if (resolved.contentType !== null) filter.contentType = resolved.contentType;
  if (resolved.language !== null) filter.language = resolved.language;

  const threshold = searchFtsRangeThresholdIso(resolved.range, resolved.referenceNow);
  if (threshold !== null) {
    const epoch = epochMsFromIso(threshold);
    if (epoch === null) throw vectorError("invalid_response", "UTC range threshold was not a parseable ISO instant");
    filter.publishedEpoch = { $gte: epoch };
  }
  return Object.keys(filter).length > 0 ? filter : null;
}
