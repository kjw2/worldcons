-- @d1-verify {"type":"table","name":"e2e_search_generation_guards_v1","sqlIncludes":["generation_seq integer","fencing_token integer","tombstone"]}
-- @d1-verify {"type":"table","name":"e2e_search_commit_guards_v1","sqlIncludes":["e2e_search_generation_match"]}
-- @d1-verify {"type":"table","name":"e2e_search_write_authorizations_v1","sqlIncludes":["article_id text primary key","token text not null"]}
-- @d1-verify {"type":"trigger","name":"e2e_search_document_insert_guard","sqlIncludes":["before insert on search_documents","e2e_search_write_authorizations_v1","raise(abort,'e2e_search_unguarded_writer')"]}
-- @d1-verify {"type":"trigger","name":"e2e_search_document_update_guard","sqlIncludes":["before update on search_documents","e2e_search_write_authorizations_v1","raise(abort,'e2e_search_unguarded_writer')"]}
-- @d1-verify {"type":"trigger","name":"e2e_search_document_delete_guard","sqlIncludes":["before delete on search_documents","e2e_search_write_authorizations_v1","raise(abort,'e2e_search_unguarded_writer')"]}
create table if not exists e2e_search_generation_guards_v1 (
  article_id text primary key not null,
  generation_id text not null,
  generation_seq integer not null check (generation_seq>0),
  version_id text not null,
  version_revision integer not null,
  publication_id text not null,
  publication_revision integer not null,
  publication_state text not null,
  policy_version text not null,
  projection_input_hash text not null,
  fencing_token integer not null check (fencing_token>0),
  tombstone integer not null check (tombstone in (0,1)),
  document_fingerprint text not null,
  fts_fingerprint text not null,
  updated_at text not null
);
create table if not exists e2e_search_commit_guards_v1 (
  token text primary key not null,
  assertion integer not null constraint e2e_search_generation_match check (assertion=1)
);
create table if not exists e2e_search_write_authorizations_v1 (
  article_id text primary key not null,
  token text not null
);
-- Persisted guards protect against old document writers, including rollback.
-- FTS virtual tables cannot have triggers: the common executor separately
-- asserts its entire plan before any document OR FTS mutation in each batch.
create trigger if not exists e2e_search_document_insert_guard before insert on search_documents
when exists (select 1 from e2e_search_generation_guards_v1 where article_id=new.article_id)
 and not exists (select 1 from e2e_search_write_authorizations_v1 where article_id=new.article_id)
begin select raise(abort,'e2e_search_unguarded_writer'); end;
create trigger if not exists e2e_search_document_update_guard before update on search_documents
when (exists (select 1 from e2e_search_generation_guards_v1 where article_id=old.article_id)
 or exists (select 1 from e2e_search_generation_guards_v1 where article_id=new.article_id))
 and (not exists (select 1 from e2e_search_write_authorizations_v1 where article_id=old.article_id)
 or not exists (select 1 from e2e_search_write_authorizations_v1 where article_id=new.article_id))
begin select raise(abort,'e2e_search_unguarded_writer'); end;
create trigger if not exists e2e_search_document_delete_guard before delete on search_documents
when exists (select 1 from e2e_search_generation_guards_v1 where article_id=old.article_id)
 and not exists (select 1 from e2e_search_write_authorizations_v1 where article_id=old.article_id)
begin select raise(abort,'e2e_search_unguarded_writer'); end;
