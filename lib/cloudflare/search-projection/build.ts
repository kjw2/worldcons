import { searchProjectionManifest, sortSearchProjectionDocuments } from "./checksum";
import { buildSearchProjectionDocument } from "./documents";
import { buildSearchProjectionFtsDocument } from "./fts-document";
import { selectPublishedSearchProjectionSources } from "./source";
import type { SearchProjectionBuildResult, SearchProjectionSourceInput } from "./types";

/**
 * Pure, runtime-neutral projection entry point.
 *
 * Selects P3 published authority, derives the deterministic `search_documents`
 * rows and their 1:1 FTS sidecar rows from the same version snapshots, and
 * returns a count/hash manifest. No remote read or write happens here; the
 * operator CLI wires local JSON fixtures into this function.
 *
 * The sidecar is built from the SAME per-article source object as the document,
 * so identity cannot drift; `ftsDocuments` is emitted in the same `article_id`
 * order as `documents`.
 */
export function buildSearchProjection(input: SearchProjectionSourceInput): SearchProjectionBuildResult {
  const sources = selectPublishedSearchProjectionSources(input);
  const built = sources.map((source) => {
    const document = buildSearchProjectionDocument(source);
    const ftsDocument = buildSearchProjectionFtsDocument(source.version, document);
    return { document, ftsDocument };
  });
  const documents = sortSearchProjectionDocuments(built.map((entry) => entry.document));
  const ftsById = new Map(built.map((entry) => [entry.document.article_id, entry.ftsDocument]));
  const ftsDocuments = documents.map((document) => ftsById.get(document.article_id)!);
  return { documents, ftsDocuments, manifest: searchProjectionManifest(documents) };
}
