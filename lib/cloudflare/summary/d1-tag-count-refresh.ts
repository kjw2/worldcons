import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";

/**
 * Update every tag using ONE materialized aggregation over article_tags.
 *
 * The previous statement ran multiple correlated COUNT/MAX scans for every
 * tag. Without an index beginning with tag_id, that was O(tags * article_tags)
 * reads per expression (millions of D1 rows per small batch).
 *
 * Materializing desired rows and joining by tag id keeps the aggregation
 * bounded by article/article_tags size and also resets tags with no matching
 * publishable articles. Only changed rows are written.
 */
export const D1_REFRESH_TAG_COUNTS_SQL = `
  WITH stats AS MATERIALIZED (
    SELECT at.tag_id,
      COUNT(*) AS article_count,
      MAX(a.original_published_at) AS latest_article_at
    FROM articles a
    JOIN article_tags at ON at.article_id=a.id
    WHERE a.status='summarized'
      AND json_valid(a.source_metadata)
      AND json_extract(a.source_metadata,'$.collection.publishable')=1
    GROUP BY at.tag_id
  ), desired AS MATERIALIZED (
    SELECT t.id, COALESCE(s.article_count,0) AS article_count,
      s.latest_article_at
    FROM tags t LEFT JOIN stats s ON s.tag_id=t.id
  )
  UPDATE tags
  SET article_count=d.article_count,
      latest_article_at=d.latest_article_at,
      updated_at=?
  FROM desired d
  WHERE tags.id=d.id
    AND (tags.article_count IS NOT d.article_count
      OR tags.latest_article_at IS NOT d.latest_article_at)
`;

export async function refreshD1TagCountMetrics(core: D1RuntimeDatabase, now = new Date().toISOString()) {
  const statement = core.prepare(D1_REFRESH_TAG_COUNTS_SQL).bind(now);
  if (!statement.run) throw new Error("summary_d1.tag_count_write_unavailable");
  const result = await statement.run();
  if (result.success === false || result.error) throw new Error("summary_d1.tag_count_refresh_failed");
  return Number(result.meta?.changes ?? 0);
}
