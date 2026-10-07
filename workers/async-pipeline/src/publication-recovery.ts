/** Lightweight fail-closed probe for ready-to-publish P3 documents.
 * Mirrors the selection predicate in runD1PublicationDrain; it must not
 * publish source-only or untranslated Case Catalog records.
 */
export const PENDING_P3_PUBLICATION_SQL = `
  SELECT a.id
  FROM articles a
  LEFT JOIN article_publications_p3 p ON p.article_id=a.id
  WHERE a.status='summarized'
    AND a.summary_json IS NOT NULL
    AND (a.translation_status='translated'
      OR (lower(COALESCE(a.original_language,''))='ko' AND a.translation_status='not_required'))
    AND json_valid(a.source_metadata)
    AND COALESCE(json_extract(a.source_metadata,'$.collection.publishable'),json_extract(a.source_metadata,'$.case.collection.publishable'))=1
    AND COALESCE(p.state,'')<>'published'
  LIMIT 1
`;

export async function hasPendingP3Publication(db: {
  prepare(sql: string): { all<T>(): Promise<{success?: boolean; error?: string | null; results?: T[]}> };
}): Promise<boolean> {
  const result = await db.prepare(PENDING_P3_PUBLICATION_SQL).all<{id: string}>();
  if (result.success === false || result.error) throw new Error("m8.pending_publication_probe_failed");
  return (result.results?.length ?? 0) > 0;
}
