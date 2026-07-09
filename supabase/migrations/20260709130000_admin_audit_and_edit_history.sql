create table if not exists admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  actor_id text,
  actor_role text default 'admin',
  action text not null,
  target_type text,
  target_id text,
  article_id uuid,
  article_slug text,
  source_key text,
  job_id text,
  result text,
  error_class text,
  redacted_metadata jsonb not null default '{}'::jsonb,
  request_ip_hash text,
  user_agent_family text
);

create table if not exists admin_article_edit_history (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references articles(id) on delete cascade,
  article_slug text,
  edited_at timestamptz not null default now(),
  actor_id text,
  changed_fields text[] not null default '{}'::text[],
  previous_summary_hash text,
  next_summary_hash text,
  diff_redacted jsonb not null default '{}'::jsonb
);

create index if not exists admin_audit_logs_occurred_at_idx
  on admin_audit_logs (occurred_at desc);

create index if not exists admin_audit_logs_action_occurred_at_idx
  on admin_audit_logs (action, occurred_at desc);

create index if not exists admin_audit_logs_target_idx
  on admin_audit_logs (target_type, target_id);

create index if not exists admin_audit_logs_job_id_idx
  on admin_audit_logs (job_id);

create index if not exists admin_article_edit_history_article_id_edited_at_idx
  on admin_article_edit_history (article_id, edited_at desc);

create index if not exists admin_article_edit_history_article_slug_edited_at_idx
  on admin_article_edit_history (article_slug, edited_at desc);
