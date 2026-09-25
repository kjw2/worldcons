import { canonicalJson } from "@/lib/backfill/canonical-json";
import { shadowDigest } from "@/lib/cloudflare/d1/shadow/digest";
import { SEARCH_PROJECTION_VERSION, type SearchProjectionDocument, type SearchProjectionDocumentBody } from "./types";

/**
 * Deterministic, runtime-neutral checksum and corpus hashing.
 *
 * The checksum covers the FULL logical search document excluding `checksum`
 * itself. `canonicalJson` sorts object keys and the projection sorts documents
 * by `article_id` before hashing, so both the per-document checksum and the
 * corpus hash are independent of input order. It reuses the existing pure
 * `shadowDigest` (a non-cryptographic 64-bit fold) because the runtime-safe
 * library must not import `node:crypto`; it is a change-detection primitive,
 * not a security hash, and it is never random or wall-clock based.
 */
export const SEARCH_PROJECTION_CHECKSUM_VERSION = 1 as const;

export function searchDocumentChecksum(document: SearchProjectionDocumentBody): string {
  return shadowDigest(`search-document/v${SEARCH_PROJECTION_CHECKSUM_VERSION}\n${canonicalJson(document)}`);
}

/** Orders documents by `article_id` for deterministic output plans and hashes. */
export function sortSearchProjectionDocuments(
  documents: readonly SearchProjectionDocument[],
): SearchProjectionDocument[] {
  return [...documents].sort((left, right) =>
    left.article_id < right.article_id ? -1 : left.article_id > right.article_id ? 1 : 0,
  );
}

/** Canonical corpus hash over the full logical documents (order-independent). */
export function hashSearchProjectionDocuments(documents: readonly SearchProjectionDocument[]): string {
  const sorted = sortSearchProjectionDocuments(documents);
  return shadowDigest(`search-projection/v${SEARCH_PROJECTION_VERSION}\n${canonicalJson(sorted)}`);
}

/** Deterministic count/hash manifest without emitting any document text. */
export function searchProjectionManifest(documents: readonly SearchProjectionDocument[]) {
  return {
    version: 1 as const,
    documentCount: documents.length,
    projectionVersion: SEARCH_PROJECTION_VERSION,
    hash: hashSearchProjectionDocuments(documents),
  };
}
