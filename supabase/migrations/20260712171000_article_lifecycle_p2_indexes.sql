create index concurrently if not exists articles_lifecycle_axes_changed_p2_idx
  on articles (lifecycle_collection_state, lifecycle_processing_state, lifecycle_review_state, lifecycle_changed_at desc);

create index concurrently if not exists articles_lifecycle_attention_p2_idx
  on articles (lifecycle_attention_state, lifecycle_attention_severity, lifecycle_attention_changed_at desc)
  where lifecycle_attention_state in ('active', 'anomaly');

create index concurrently if not exists article_lifecycle_events_p2_article_occurred_idx
  on article_lifecycle_events_p2 (article_id, occurred_at desc);

create index concurrently if not exists article_lifecycle_anomalies_p2_unresolved_idx
  on article_lifecycle_anomalies_p2 (anomaly_code, legacy_status, last_seen_at desc)
  where resolved_at is null;
