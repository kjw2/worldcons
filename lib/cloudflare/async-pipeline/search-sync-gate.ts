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

export function needsSearchSyncAfterCrawler(sourceCount: number): boolean {
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 0) {
    throw new Error("m8.crawler_invalid_source_count");
  }
  return sourceCount > 0;
}
