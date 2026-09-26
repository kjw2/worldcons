import { buildSearchProjection } from "@/lib/cloudflare/search-projection";
import { buildVectorProjection } from "@/lib/cloudflare/search-vector";
import type {
  NarrowSearchSourceSnapshot,
  SearchMaterializationProjection,
} from "./types";

/**
 * Builds the desired projection from one stable narrow source snapshot.
 *
 * It reuses the unchanged M7.1 `buildSearchProjection` and M7.4
 * `buildVectorProjection`, so the materialized rows are byte-identical to the
 * local foundations. The added value is the safe manifest: counts and
 * deterministic hashes only, never document text, embeddings, URLs or metadata.
 */
export function buildSearchMaterializationProjection(
  snapshot: NarrowSearchSourceSnapshot,
): SearchMaterializationProjection {
  const search = buildSearchProjection({
    publications: snapshot.rows.publications,
    versions: snapshot.rows.versions,
    articles: snapshot.rows.articles,
    tags: snapshot.rows.tags,
    articleTags: snapshot.rows.articleTags,
  });
  const vector = buildVectorProjection({
    publications: snapshot.rows.publications,
    versions: snapshot.rows.versions,
    articles: snapshot.rows.articles,
    tags: snapshot.rows.tags,
    articleTags: snapshot.rows.articleTags,
    artifacts: snapshot.rows.artifacts,
  });

  return {
    search: {
      documents: search.documents,
      ftsDocuments: search.ftsDocuments,
      manifest: {
        documentCount: search.manifest.documentCount,
        hash: search.manifest.hash,
        projectionVersion: search.manifest.projectionVersion,
      },
    },
    vector,
    desired: {
      search: { documentCount: search.manifest.documentCount, hash: search.manifest.hash },
      ftsDocumentCount: search.ftsDocuments.length,
      vector: {
        recordCount: vector.manifest.recordCount,
        hash: vector.manifest.hash,
        missingCount: vector.manifest.missingCount,
        staleCount: vector.manifest.staleCount,
      },
    },
  };
}
