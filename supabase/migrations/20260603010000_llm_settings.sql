create table if not exists llm_settings (
  id text primary key,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists llm_settings_set_updated_at on llm_settings;
create trigger llm_settings_set_updated_at
before update on llm_settings
for each row execute function set_updated_at();

