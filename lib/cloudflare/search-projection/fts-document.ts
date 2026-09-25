import { encodeFtsTitle } from "@/lib/cloudflare/search-fts/title";
import { projectionError } from "./errors";
import type {
  SearchProjectionDocument,
  SearchProjectionFtsDocument,
  SearchVersionP3Row,
} from "./types";

/**
 * Sidecar FTS5 row construction (M7.2).
 *
 * The sidecar is derived from the SAME authoritative P3 version snapshot as the
 * `search_documents` row, so it stays a deterministic pure function of the
 * authority and keeps a 1:1 `article_id` identity with `search_documents`.
 *
 * `title` deterministically encodes normalized variants of BOTH the original and
 * Korean titles (searchable and exact-matchable). `search_documents` itself is
 * never modified, preserving its authored shape and checksum behavior.
 */
export function buildSearchProjectionFtsDocument(
  version: SearchVersionP3Row,
  document: SearchProjectionDocument,
): SearchProjectionFtsDocument {
  if (version.article_id !== document.article_id) {
    throw projectionError(
      "fts_document_identity_mismatch",
      `FTS sidecar article ${document.article_id} does not match version article ${version.article_id}`,
      document.article_id,
    );
  }
  return {
    article_id: document.article_id,
    title: encodeFtsTitle(version.original_title, version.korean_title),
    case_numbers: document.case_numbers ?? "",
    search_text: document.search_text ?? "",
    tags_text: document.tags_text ?? "",
  };
}

/** Orders sidecar rows by `article_id` for deterministic plans. */
export function sortSearchProjectionFtsDocuments(
  documents: readonly SearchProjectionFtsDocument[],
): SearchProjectionFtsDocument[] {
  return [...documents].sort((left, right) =>
    left.article_id < right.article_id ? -1 : left.article_id > right.article_id ? 1 : 0,
  );
}

/**
 * Indexes sidecar rows by `article_id`, failing closed on duplicate identity so a
 * plan can never bind two FTS rows to one authoritative article.
 */
export function indexSearchProjectionFtsDocuments(
  documents: readonly SearchProjectionFtsDocument[],
  label: string,
): Map<string, SearchProjectionFtsDocument> {
  const byId = new Map<string, SearchProjectionFtsDocument>();
  for (const document of documents) {
    if (byId.has(document.article_id)) {
      throw projectionError(
        "duplicate_fts_document_id",
        `${label} contains duplicate FTS sidecar article_id ${document.article_id}`,
        document.article_id,
      );
    }
    byId.set(document.article_id, document);
  }
  return byId;
}

/**
 * Asserts that sidecar rows are exactly 1:1 with projected documents and returns
 * them in document order. Any count/identity mismatch fails closed.
 */
export function alignSearchProjectionFtsDocuments(
  documents: readonly SearchProjectionDocument[],
  ftsDocuments: readonly SearchProjectionFtsDocument[],
  label: string,
): SearchProjectionFtsDocument[] {
  const byId = indexSearchProjectionFtsDocuments(ftsDocuments, label);
  if (byId.size !== documents.length) {
    throw projectionError(
      "fts_document_count_mismatch",
      `${label} has ${byId.size} FTS sidecar rows for ${documents.length} documents`,
      null,
    );
  }
  return documents.map((document) => {
    const ftsDocument = byId.get(document.article_id);
    if (!ftsDocument) {
      throw projectionError(
        "missing_fts_document",
        `${label} is missing an FTS sidecar row for article ${document.article_id}`,
        document.article_id,
      );
    }
    return ftsDocument;
  });
}
