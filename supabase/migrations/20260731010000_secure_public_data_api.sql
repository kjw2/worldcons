-- WorldCons accesses Supabase only through trusted server-side service-role clients.
-- Keep the public schema unavailable to anonymous Data API roles.

do $$
declare
  table_record record;
begin
  for table_record in
    select n.nspname as schema_name, c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
  loop
    execute format(
      'alter table %I.%I enable row level security',
      table_record.schema_name,
      table_record.table_name
    );
  end loop;
end;
$$;

revoke all privileges on all tables in schema public
  from public, anon, authenticated;

revoke all privileges on all sequences in schema public
  from public, anon, authenticated;

revoke all privileges on all routines in schema public
  from public, anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all privileges on tables from public, anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all privileges on sequences from public, anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all privileges on routines from public, anon, authenticated;
