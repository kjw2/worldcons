/**
 * A publication or crawler workflow should only pay for the full Search
 * projection scan when that upstream workflow could have changed the corpus.
 * Standalone search-projection-sync jobs remain the explicit reconciliation
 * and recovery path, including when publication/crawling made no changes.
 */
export function needsSearchSyncAfterPublication(publication: { publishedCount: number }): boolean {
  if (!Number.isSafeInteger(publication.publishedCount) || publication.publishedCount < 0) {
    throw new Error("m8.publication_invalid_published_count");
  }
  return publication.publishedCount > 0;
}

export function needsSearchSyncAfterCrawler(
  results: readonly { insertedCount: number; refreshedCount: number; provenanceAttachedCount?: number }[],
): boolean {
  return results.some(result => {
    // Unknown/malformed result counts must not silently skip a recovery scan.
    const changes = [result.insertedCount, result.refreshedCount, result.provenanceAttachedCount ?? 0];
    return changes.some(count => !Number.isSafeInteger(count) || count < 0 || count > 0);
  });
}
