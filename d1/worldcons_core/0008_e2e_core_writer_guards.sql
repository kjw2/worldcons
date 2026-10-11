-- @d1-verify {"type":"table","name":"e2e_core_write_authorizations_v1","sqlIncludes":["article_id text primary key","references e2e_commit_guards_v1"]}
create table if not exists e2e_core_write_authorizations_v1 (
  article_id text primary key not null,
  token text not null references e2e_commit_guards_v1(token) on delete cascade
);
-- @d1-verify {"type":"trigger","name":"e2e_core_article_version_heads_p3_insert_guard","sqlIncludes":["before insert on article_version_heads_p3","raise(abort,'e2e_core_unguarded_writer')"]}
create trigger if not exists e2e_core_article_version_heads_p3_insert_guard before insert on article_version_heads_p3
when (exists (select 1 from e2e_generation_heads_v1 where article_id=new.article_id)) and (not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=new.article_id))
begin select raise(abort,'e2e_core_unguarded_writer'); end;
-- @d1-verify {"type":"trigger","name":"e2e_core_article_version_heads_p3_update_guard","sqlIncludes":["before update on article_version_heads_p3","raise(abort,'e2e_core_unguarded_writer')"]}
create trigger if not exists e2e_core_article_version_heads_p3_update_guard before update on article_version_heads_p3
when (exists (select 1 from e2e_generation_heads_v1 where article_id=old.article_id) or exists (select 1 from e2e_generation_heads_v1 where article_id=new.article_id)) and (not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=old.article_id) or not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=new.article_id))
begin select raise(abort,'e2e_core_unguarded_writer'); end;
-- @d1-verify {"type":"trigger","name":"e2e_core_article_version_heads_p3_delete_guard","sqlIncludes":["before delete on article_version_heads_p3","raise(abort,'e2e_core_unguarded_writer')"]}
create trigger if not exists e2e_core_article_version_heads_p3_delete_guard before delete on article_version_heads_p3
when (exists (select 1 from e2e_generation_heads_v1 where article_id=old.article_id)) and (not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=old.article_id))
begin select raise(abort,'e2e_core_unguarded_writer'); end;
-- @d1-verify {"type":"trigger","name":"e2e_core_article_revision_heads_v4_insert_guard","sqlIncludes":["before insert on article_revision_heads_v4","raise(abort,'e2e_core_unguarded_writer')"]}
create trigger if not exists e2e_core_article_revision_heads_v4_insert_guard before insert on article_revision_heads_v4
when (exists (select 1 from e2e_generation_heads_v1 where article_id=new.article_id)) and (not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=new.article_id))
begin select raise(abort,'e2e_core_unguarded_writer'); end;
-- @d1-verify {"type":"trigger","name":"e2e_core_article_revision_heads_v4_update_guard","sqlIncludes":["before update on article_revision_heads_v4","raise(abort,'e2e_core_unguarded_writer')"]}
create trigger if not exists e2e_core_article_revision_heads_v4_update_guard before update on article_revision_heads_v4
when (exists (select 1 from e2e_generation_heads_v1 where article_id=old.article_id) or exists (select 1 from e2e_generation_heads_v1 where article_id=new.article_id)) and (not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=old.article_id) or not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=new.article_id))
begin select raise(abort,'e2e_core_unguarded_writer'); end;
-- @d1-verify {"type":"trigger","name":"e2e_core_article_revision_heads_v4_delete_guard","sqlIncludes":["before delete on article_revision_heads_v4","raise(abort,'e2e_core_unguarded_writer')"]}
create trigger if not exists e2e_core_article_revision_heads_v4_delete_guard before delete on article_revision_heads_v4
when (exists (select 1 from e2e_generation_heads_v1 where article_id=old.article_id)) and (not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=old.article_id))
begin select raise(abort,'e2e_core_unguarded_writer'); end;
-- @d1-verify {"type":"trigger","name":"e2e_core_article_publications_p3_insert_guard","sqlIncludes":["before insert on article_publications_p3","raise(abort,'e2e_core_unguarded_writer')"]}
create trigger if not exists e2e_core_article_publications_p3_insert_guard before insert on article_publications_p3
when (exists (select 1 from e2e_generation_heads_v1 where article_id=new.article_id)) and (not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=new.article_id))
begin select raise(abort,'e2e_core_unguarded_writer'); end;
-- @d1-verify {"type":"trigger","name":"e2e_core_article_publications_p3_update_guard","sqlIncludes":["before update on article_publications_p3","raise(abort,'e2e_core_unguarded_writer')"]}
create trigger if not exists e2e_core_article_publications_p3_update_guard before update on article_publications_p3
when (exists (select 1 from e2e_generation_heads_v1 where article_id=old.article_id) or exists (select 1 from e2e_generation_heads_v1 where article_id=new.article_id)) and (not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=old.article_id) or not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=new.article_id))
begin select raise(abort,'e2e_core_unguarded_writer'); end;
-- @d1-verify {"type":"trigger","name":"e2e_core_article_publications_p3_delete_guard","sqlIncludes":["before delete on article_publications_p3","raise(abort,'e2e_core_unguarded_writer')"]}
create trigger if not exists e2e_core_article_publications_p3_delete_guard before delete on article_publications_p3
when (exists (select 1 from e2e_generation_heads_v1 where article_id=old.article_id)) and (not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=old.article_id))
begin select raise(abort,'e2e_core_unguarded_writer'); end;
-- @d1-verify {"type":"trigger","name":"e2e_core_e2e_generation_heads_v1_insert_guard","sqlIncludes":["before insert on e2e_generation_heads_v1","raise(abort,'e2e_core_unguarded_writer')"]}
create trigger if not exists e2e_core_e2e_generation_heads_v1_insert_guard before insert on e2e_generation_heads_v1
when (exists (select 1 from e2e_generation_heads_v1 where article_id=new.article_id)) and (not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=new.article_id))
begin select raise(abort,'e2e_core_unguarded_writer'); end;
-- @d1-verify {"type":"trigger","name":"e2e_core_e2e_generation_heads_v1_update_guard","sqlIncludes":["before update on e2e_generation_heads_v1","raise(abort,'e2e_core_unguarded_writer')"]}
create trigger if not exists e2e_core_e2e_generation_heads_v1_update_guard before update on e2e_generation_heads_v1
when (exists (select 1 from e2e_generation_heads_v1 where article_id=old.article_id) or exists (select 1 from e2e_generation_heads_v1 where article_id=new.article_id)) and (not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=old.article_id) or not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=new.article_id))
begin select raise(abort,'e2e_core_unguarded_writer'); end;
-- @d1-verify {"type":"trigger","name":"e2e_core_e2e_generation_heads_v1_delete_guard","sqlIncludes":["before delete on e2e_generation_heads_v1","raise(abort,'e2e_core_unguarded_writer')"]}
create trigger if not exists e2e_core_e2e_generation_heads_v1_delete_guard before delete on e2e_generation_heads_v1
when (exists (select 1 from e2e_generation_heads_v1 where article_id=old.article_id)) and (not exists (select 1 from e2e_core_write_authorizations_v1 a join e2e_commit_guards_v1 c on c.token=a.token and c.assertion=1 where a.article_id=old.article_id))
begin select raise(abort,'e2e_core_unguarded_writer'); end;
-- @d1-verify {"type":"trigger","name":"e2e_core_article_delete_guard","sqlIncludes":["before delete on articles","e2e_generation_heads_v1"]}
create trigger if not exists e2e_core_article_delete_guard before delete on articles
when exists (select 1 from e2e_generation_heads_v1 where article_id=old.id)
begin select raise(abort,'e2e_core_managed_article_delete'); end;
-- Published snapshots are immutable, including when an old Worker is restored.
-- Blob storage locations may still be externalized without changing content.
-- @d1-verify {"type":"trigger","name":"e2e_core_version_update_guard","sqlIncludes":["before update on article_content_versions_p3","e2e_core_immutable_version"]}
create trigger if not exists e2e_core_version_update_guard before update on article_content_versions_p3
when exists (select 1 from e2e_generation_heads_v1 where article_id=old.article_id)
 and (old.id is not new.id or old.article_id is not new.article_id or old.revision is not new.revision or old.parent_version_id is not new.parent_version_id or old.content_hash is not new.content_hash or old.case_key is not new.case_key or old.slug is not new.slug or old.source_key is not new.source_key or old.jurisdiction is not new.jurisdiction or old.institution_name is not new.institution_name or old.content_type is not new.content_type or old.original_url is not new.original_url or old.canonical_url is not new.canonical_url or old.original_language is not new.original_language or old.original_title is not new.original_title or old.korean_title is not new.korean_title or old.original_published_at is not new.original_published_at or old.cleaned_text is not new.cleaned_text or old.summary_json is not new.summary_json or old.source_metadata is not new.source_metadata or old.error_metadata is not new.error_metadata or old.version_role is not new.version_role or old.source_anchor_version_id is not new.source_anchor_version_id or old.source_content_hash is not new.source_content_hash)
begin select raise(abort,'e2e_core_immutable_version'); end;
-- @d1-verify {"type":"trigger","name":"e2e_core_version_delete_guard","sqlIncludes":["before delete on article_content_versions_p3","e2e_core_immutable_version"]}
create trigger if not exists e2e_core_version_delete_guard before delete on article_content_versions_p3
when exists (select 1 from e2e_generation_heads_v1 where article_id=old.article_id)
begin select raise(abort,'e2e_core_immutable_version'); end;
