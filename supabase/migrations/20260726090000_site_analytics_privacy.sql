-- Minimize public analytics data and enforce a bounded retention window.
update site_events
set
  client_ip = null,
  user_agent = null,
  client_region = null,
  client_city = null;

update site_events
set search_query = '[민감정보 숨김]'
where search_query ~* '([[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}|https?://|www\.|(\+?[[:digit:]]{1,3}[ .-]?)?(0[[:digit:]]{1,2}|[[:digit:]]{2,3})[ .-][[:digit:]]{3,4}[ .-][[:digit:]]{4})';

drop index if exists site_events_client_ip_idx;

alter table site_events
  drop column if exists client_ip,
  drop column if exists user_agent,
  drop column if exists client_region,
  drop column if exists client_city;

create or replace function purge_site_events(retention_days integer default 90)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  if retention_days < 30 or retention_days > 365 then
    raise exception 'retention_days must be between 30 and 365';
  end if;

  delete from site_events
  where occurred_at < now() - make_interval(days => retention_days);

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function purge_site_events(integer) from public;

do $$
begin
  if exists(select 1 from pg_roles where rolname = 'anon') then
    revoke all on function purge_site_events(integer) from anon;
  end if;
  if exists(select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function purge_site_events(integer) from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function purge_site_events(integer) to service_role;
  end if;
end
$$;

select purge_site_events(90);
