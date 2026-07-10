create or replace function claim_admin_job(worker_id text, job_types text[], lease_seconds integer default 60)
returns setof admin_jobs
language plpgsql
as $$
declare
  v_worker_id alias for $1;
  v_job_types alias for $2;
  v_lease_seconds alias for $3;
begin
  return query
  with candidate as (
    select j.id
    from admin_jobs j
    where (
        v_job_types is null
        or cardinality(v_job_types) = 0
        or j.job_type = any(v_job_types)
      )
      and (
        j.status = 'queued'
        or (j.status = 'running' and j.lease_until < now())
      )
    order by
      case when j.status = 'running' then 0 else 1 end,
      j.priority desc,
      j.requested_at asc
    for update skip locked
    limit 1
  )
  update admin_jobs j
  set
    status = 'running',
    started_at = coalesce(j.started_at, now()),
    lease_until = now() + make_interval(secs => greatest(coalesce(v_lease_seconds, 60), 1)),
    worker_id = v_worker_id,
    updated_at = now()
  from candidate
  where j.id = candidate.id
  returning j.*;
end;
$$;
