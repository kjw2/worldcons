-- Search success is durable but is NOT final content/API verification (M4).
-- @d1-verify {"type":"table","name":"e2e_search_apply_receipts_v1","sqlIncludes":["generation_id text primary key","fencing_token integer"]}
create table if not exists e2e_search_apply_receipts_v1 (
  generation_id text primary key not null references e2e_generations_v1(generation_id),
  outbox_id text not null references e2e_search_repair_outbox_v1(outbox_id),
  fencing_token integer not null,
  document_fingerprint text not null,
  fts_fingerprint text not null,
  applied_at text not null
);
