create index if not exists article_content_versions_p3_article_created_idx
  on article_content_versions_p3 (article_id, created_at desc);

create index if not exists article_content_versions_p3_public_order_idx
  on article_content_versions_p3 (original_published_at desc nulls last, article_id);

create index if not exists article_content_versions_p3_source_order_idx
  on article_content_versions_p3 (source_key, original_published_at desc nulls last, article_id);

create index if not exists article_content_versions_p3_jurisdiction_order_idx
  on article_content_versions_p3 (jurisdiction, original_published_at desc nulls last, article_id);

create index if not exists article_content_versions_p3_search_vector_idx
  on article_content_versions_p3 using gin (search_vector);

create index if not exists article_content_versions_p3_embedding_idx
  on article_content_versions_p3 using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create index if not exists article_publications_p3_state_version_idx
  on article_publications_p3 (state, version_id, article_id);

create index if not exists article_publication_history_p3_article_occurred_idx
  on article_publication_history_p3 (article_id, occurred_at desc);

create index if not exists article_audit_ledger_p3_event_occurred_idx
  on article_audit_ledger_p3 (event_type, occurred_at desc);

create index if not exists article_cache_outbox_p3_claim_idx
  on article_cache_outbox_p3 (available_at, created_at, id)
  where status = 'pending';

create index if not exists article_cache_outbox_p3_lease_idx
  on article_cache_outbox_p3 (lease_expires_at, id)
  where status = 'processing';

create index if not exists article_cache_outbox_p3_dead_letter_idx
  on article_cache_outbox_p3 (dead_lettered_at desc, id)
  where status = 'dead_letter';
