import { searchProjectionManifest, sortSearchProjectionDocuments } from "./checksum";
import { buildSearchProjectionDocument } from "./documents";
import { selectPublishedSearchProjectionSources } from "./source";
import type { SearchProjectionBuildResult, SearchProjectionSourceInput } from "./types";

/**
 * Pure, runtime-neutral projection entry point.
 *
 * Selects P3 published authority, derives the deterministic `search_documents`
 * rows from the version snapshots, and returns a count/hash manifest. No remote
 * read or write happens here; the operator CLI wires local JSON fixtures into
 * this function.
 */
export function buildSearchProjection(input: SearchProjectionSourceInput): SearchProjectionBuildResult {
  const sources = selectPublishedSearchProjectionSources(input);
  const documents = sortSearchProjectionDocuments(sources.map(buildSearchProjectionDocument));
  return { documents, manifest: searchProjectionManifest(documents) };
}
