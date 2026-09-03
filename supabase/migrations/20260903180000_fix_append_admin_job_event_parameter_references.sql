begin;

-- Match the earlier claim_admin_job correction: PL/pgSQL block-label
-- qualification is valid at runtime, but pg_lint parses the qualifier as a missing SQL
-- relation. Positional aliases preserve the published RPC argument names.
create or replace function append_admin_job_event(
  job_id uuid,
  event_type text,
  message text default null,
  error_class text default null,
  metadata jsonb default '{}'::jsonb
)
returns admin_job_events
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_job_id alias for $1;
  v_event_type alias for $2;
  v_message alias for $3;
  v_error_class alias for $4;
  v_metadata alias for $5;
  v_inserted admin_job_events;
begin
  insert into admin_job_events(job_id,event_type,message,error_class,metadata)
  values(v_job_id,v_event_type,v_message,v_error_class,coalesce(v_metadata,'{}'::jsonb))
  returning * into v_inserted;

  return v_inserted;
end;
$function$;

revoke all on function append_admin_job_event(uuid,text,text,text,jsonb) from public;

do $permissions$
begin
  if exists(select 1 from pg_roles where rolname='anon') then
    revoke all on function append_admin_job_event(uuid,text,text,text,jsonb) from anon;
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    revoke all on function append_admin_job_event(uuid,text,text,text,jsonb) from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant execute on function append_admin_job_event(uuid,text,text,text,jsonb) to service_role;
  end if;
end;
$permissions$;

notify pgrst,'reload schema';
commit;
