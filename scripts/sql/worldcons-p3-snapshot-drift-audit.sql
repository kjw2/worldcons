-- WorldCons P3 published snapshot drift audit (READ ONLY).
-- Run via: pnpm exec wrangler d1 execute worldcons_core --remote --yes --json
--   --config workers/async-pipeline/wrangler.jsonc
--   --file scripts/sql/worldcons-p3-snapshot-drift-audit.sql
-- A P3 version's freshness='current' is not proof of equality to mutable Core.
SELECT
  a.source_key,
  COUNT(*) AS published,
  SUM(CASE WHEN a.cleaned_text IS v.cleaned_text THEN 0 ELSE 1 END) AS text_drift,
  SUM(CASE WHEN a.summary_json IS v.summary_json THEN 0 ELSE 1 END) AS summary_drift,
  SUM(CASE WHEN a.korean_title IS v.korean_title THEN 0 ELSE 1 END) AS title_drift,
  SUM(CASE WHEN a.canonical_url IS v.canonical_url THEN 0 ELSE 1 END) AS url_drift,
  SUM(CASE WHEN a.cleaned_text IS v.cleaned_text
            AND a.summary_json IS v.summary_json
            AND a.korean_title IS v.korean_title
            AND a.canonical_url IS v.canonical_url THEN 0 ELSE 1 END) AS any_snapshot_drift
FROM article_publications_p3 p
JOIN articles a ON a.id = p.article_id
LEFT JOIN article_content_versions_p3 v ON v.id = p.version_id AND v.article_id = p.article_id
WHERE p.state = 'published'
GROUP BY a.source_key
ORDER BY a.source_key;

SELECT
  a.id AS article_id, a.source_key, a.original_title,
  a.updated_at AS core_updated_at, p.updated_at AS p3_updated_at,
  p.version_id, p.revision AS publication_revision,
  a.review_state, a.lifecycle_collection_state, a.lifecycle_processing_state,
  a.lifecycle_review_state, a.lifecycle_attention_state,
  json_extract(a.source_metadata, '$.collection.publishable') AS publishable,
  json_extract(a.source_metadata, '$.collection.sourceTextAvailable') AS source_text_available,
  json_extract(a.source_metadata, '$.collection.sourceUrlVerified') AS source_url_verified,
  json_extract(a.source_metadata, '$.collectionSafety.publishable') AS legacy_safety_publishable,
  LENGTH(a.cleaned_text) AS core_text_chars, LENGTH(v.cleaned_text) AS p3_text_chars,
  CASE WHEN a.cleaned_text IS v.cleaned_text THEN 1 ELSE 0 END AS text_equal,
  CASE WHEN a.summary_json IS v.summary_json THEN 1 ELSE 0 END AS summary_equal,
  CASE WHEN a.korean_title IS v.korean_title THEN 1 ELSE 0 END AS title_equal,
  CASE WHEN a.canonical_url IS v.canonical_url THEN 1 ELSE 0 END AS url_equal
FROM article_publications_p3 p
JOIN articles a ON a.id = p.article_id
LEFT JOIN article_content_versions_p3 v ON v.id = p.version_id AND v.article_id = p.article_id
WHERE p.state = 'published'
  AND (a.cleaned_text IS NOT v.cleaned_text
       OR a.summary_json IS NOT v.summary_json
       OR a.korean_title IS NOT v.korean_title
       OR a.canonical_url IS NOT v.canonical_url)
ORDER BY a.source_key, a.id;
