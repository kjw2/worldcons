begin;

-- Gate 3 search reads the already fail-closed progressive detail projection.
-- It never concatenates Catalog and P3 rows in application memory, so one article
-- has one representative document and stale P3 content cannot enter ranking.
create or replace view public_case_search_documents_v1
with (security_barrier = true)
as
select
  d.id,d.slug,d.source_key,d.jurisdiction,d.institution_name,d.content_type,
  d.original_language,d.original_title,d.korean_title,d.original_published_at,
  d.search_vector,d.article_tags,d.case_key,d.enrichment_status,
  d.enrichment_freshness,d.summary_status,d.summary_available
from public_article_detail_v4 d;

create index if not exists case_identifiers_v1_normalized_search_idx
  on case_identifiers_v1(normalized_value, identifier_type, article_id);

create or replace function worldcons_case_search_fingerprint_v1(
  p_query text,
  p_source text,
  p_jurisdiction text,
  p_content_type text,
  p_language text,
  p_tag text,
  p_range text
)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $function$
  select encode(extensions.digest(convert_to(concat_ws(chr(31),
    lower(trim(coalesce(p_query,''))),coalesce(p_source,''),coalesce(p_jurisdiction,''),
    coalesce(p_content_type,''),coalesce(p_language,''),coalesce(p_tag,''),
    coalesce(p_range,'latest'),'gate3-exact-lexical-v1'
  ),'UTF8'),'sha256'),'hex')
$function$;

create or replace function worldcons_case_search_cursor_encode_v1(
  p_fingerprint text,
  p_mode text,
  p_score double precision,
  p_sort_date timestamptz,
  p_article_id uuid,
  p_position bigint
)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $function$
  select translate(replace(replace(rtrim(encode(convert_to(jsonb_build_object(
    'version','gate3-exact-lexical-v1','fingerprint',p_fingerprint,'mode',p_mode,
    'score',p_score,'sortDate',p_sort_date,'articleId',p_article_id,'position',p_position
  )::text,'UTF8'),'base64'),'='),E'\n',''),E'\r',''),'+/','-_')
$function$;

create or replace function worldcons_case_search_cursor_decode_v1(p_cursor text)
returns jsonb
language plpgsql
immutable
set search_path = public, extensions, pg_temp
as $function$
declare
  v_base64 text;
  v_payload jsonb;
begin
  if p_cursor is null or p_cursor='' or length(p_cursor)>2048 or p_cursor !~ '^[A-Za-z0-9_-]+$' then
    raise exception using errcode='22023',message='WORLDCONS_CASE_SEARCH_INVALID_CURSOR';
  end if;
  v_base64:=translate(p_cursor,'-_','+/');
  v_base64:=v_base64||repeat('=',(4-length(v_base64)%4)%4);
  v_payload:=convert_from(decode(v_base64,'base64'),'UTF8')::jsonb;
  if jsonb_typeof(v_payload)<>'object'
    or v_payload->>'version'<>'gate3-exact-lexical-v1'
    or v_payload->>'mode' not in ('exact-identity','lexical','latest')
    or coalesce((v_payload->>'position')::bigint,-1)<0
  then
    raise exception using errcode='22023',message='WORLDCONS_CASE_SEARCH_INVALID_CURSOR';
  end if;
  perform (v_payload->>'score')::double precision;
  perform (v_payload->>'sortDate')::timestamptz;
  perform (v_payload->>'articleId')::uuid;
  return v_payload;
exception when others then
  raise exception using errcode='22023',message='WORLDCONS_CASE_SEARCH_INVALID_CURSOR';
end;
$function$;

create or replace function worldcons_case_search_ranked_v1(
  p_query text default '',
  p_source text default null,
  p_jurisdiction text default null,
  p_content_type text default null,
  p_language text default null,
  p_tag text default null,
  p_range text default 'latest'
)
returns table(
  article_id uuid,
  score double precision,
  sort_date timestamptz,
  matched_by text,
  enrichment_status text,
  enrichment_freshness text,
  summary_status text,
  summary_available boolean
)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
set statement_timeout = '2500ms'
as $function$
  with input as (
    select
      trim(coalesce(p_query,'')) as query_text,
      lower(regexp_replace(trim(coalesce(p_query,'')),'[^[:alnum:]]','','g')) as normalized_query,
      worldcons_query_case_reference_v1(p_query) as case_reference
  ), filtered as (
    select d.*
    from public_case_search_documents_v1 d
    where (p_source is null or d.source_key=p_source)
      and (p_jurisdiction is null or d.jurisdiction=p_jurisdiction)
      and (p_content_type is null or d.content_type=p_content_type)
      and (p_language is null or d.original_language=p_language)
      and (p_tag is null or exists(
        select 1 from jsonb_array_elements(coalesce(d.article_tags,'[]'::jsonb)) item
        where item->'tags'->>'slug'=p_tag or item->'tags'->>'name'=p_tag
      ))
      and (
        coalesce(p_range,'latest')='latest'
        or (p_range='today' and d.original_published_at>=current_date)
        or (p_range='week' and d.original_published_at>=current_date-interval '7 days')
        or (p_range='month' and d.original_published_at>=current_date-interval '30 days')
      )
  ), exact_candidates as (
    select
      d.id,
      (1000-coalesce((
        select min(case ci.identifier_type
          when 'source_record_id' then 1 when 'ecli' then 1 when 'hj_id' then 1
          when 'reporter_citation' then 2 when 'decision_number' then 3
          when 'docket' then 4 when 'case_key' then 5 else 9 end)
        from case_identifiers_v1 ci,input i
        where ci.article_id=d.id and i.normalized_query<>'' and ci.normalized_value=i.normalized_query
      ),case when exists(
        select 1 from input i where i.case_reference is not null
          and d.source_key=i.case_reference->>'sourceKey'
          and d.case_key=i.case_reference->>'caseKey'
      ) then 5 else 9 end))::double precision as identity_score
    from filtered d
    where exists(
      select 1 from case_identifiers_v1 ci,input i
      where ci.article_id=d.id and i.normalized_query<>'' and ci.normalized_value=i.normalized_query
    ) or exists(
      select 1 from input i where i.case_reference is not null
        and d.source_key=i.case_reference->>'sourceKey'
        and d.case_key=i.case_reference->>'caseKey'
    )
  ), strategy as (
    select case
      when exists(select 1 from exact_candidates) then 'exact-identity'
      when (select query_text from input)='' then 'latest'
      else 'lexical'
    end as mode
  ), ranked as (
    select d.id as article_id,e.identity_score as score,
      coalesce(d.original_published_at,'0001-01-01 00:00:00+00'::timestamptz) as sort_date,
      'exact-identity'::text as matched_by,d.enrichment_status,d.enrichment_freshness,
      d.summary_status,d.summary_available
    from exact_candidates e join filtered d on d.id=e.id
    where (select mode from strategy)='exact-identity'
    union all
    select d.id,
      (ts_rank_cd(d.search_vector,websearch_to_tsquery('simple',i.query_text),32)
        + case when lower(regexp_replace(trim(coalesce(d.korean_title,'')),'[[:space:]]+',' ','g'))=lower(regexp_replace(i.query_text,'[[:space:]]+',' ','g'))
          or lower(regexp_replace(trim(coalesce(d.original_title,'')),'[[:space:]]+',' ','g'))=lower(regexp_replace(i.query_text,'[[:space:]]+',' ','g')) then 10 else 0 end)::double precision,
      coalesce(d.original_published_at,'0001-01-01 00:00:00+00'::timestamptz),
      'lexical'::text,d.enrichment_status,d.enrichment_freshness,d.summary_status,d.summary_available
    from filtered d cross join input i
    where (select mode from strategy)='lexical'
      and d.search_vector is not null
      and d.search_vector@@websearch_to_tsquery('simple',i.query_text)
    union all
    select d.id,0::double precision,
      coalesce(d.original_published_at,'0001-01-01 00:00:00+00'::timestamptz),
      'latest'::text,d.enrichment_status,d.enrichment_freshness,d.summary_status,d.summary_available
    from filtered d
    where (select mode from strategy)='latest'
  )
  select r.* from ranked r
$function$;

create or replace function worldcons_case_search_page_v2(
  p_query text default '',
  p_limit integer default 20,
  p_cursor text default null,
  p_source text default null,
  p_jurisdiction text default null,
  p_content_type text default null,
  p_language text default null,
  p_tag text default null,
  p_range text default 'latest'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
set statement_timeout = '3000ms'
as $function$
declare
  v_query text:=trim(coalesce(p_query,''));
  v_fingerprint text;
  v_cursor jsonb;
  v_cursor_score double precision;
  v_cursor_date timestamptz;
  v_cursor_id uuid;
  v_cursor_mode text;
  v_position bigint:=0;
  v_entries jsonb:='[]'::jsonb;
  v_last jsonb;
  v_page_count integer:=0;
  v_has_more boolean:=false;
  v_mode text;
  v_returned integer:=0;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode='22023',message='WORLDCONS_CASE_SEARCH_INVALID_LIMIT';
  end if;
  if length(v_query)>200 then
    raise exception using errcode='22023',message='WORLDCONS_CASE_SEARCH_INVALID_QUERY';
  end if;
  if coalesce(p_range,'latest') not in ('latest','today','week','month') then
    raise exception using errcode='22023',message='WORLDCONS_CASE_SEARCH_INVALID_RANGE';
  end if;

  v_fingerprint:=worldcons_case_search_fingerprint_v1(
    v_query,p_source,p_jurisdiction,p_content_type,p_language,p_tag,p_range
  );
  if p_cursor is not null then
    v_cursor:=worldcons_case_search_cursor_decode_v1(p_cursor);
    if v_cursor->>'fingerprint' is distinct from v_fingerprint then
      raise exception using errcode='22023',message='WORLDCONS_CASE_SEARCH_CURSOR_MISMATCH';
    end if;
    v_cursor_score:=(v_cursor->>'score')::double precision;
    v_cursor_date:=(v_cursor->>'sortDate')::timestamptz;
    v_cursor_id:=(v_cursor->>'articleId')::uuid;
    v_cursor_mode:=v_cursor->>'mode';
    v_position:=(v_cursor->>'position')::bigint;
  end if;

  with eligible as (
    select r.*
    from worldcons_case_search_ranked_v1(
      v_query,p_source,p_jurisdiction,p_content_type,p_language,p_tag,p_range
    ) r
    where p_cursor is null or (
      r.matched_by=v_cursor_mode and (
        r.score<v_cursor_score
        or (r.score=v_cursor_score and r.sort_date<v_cursor_date)
        or (r.score=v_cursor_score and r.sort_date=v_cursor_date and r.article_id>v_cursor_id)
      )
    )
  ), page as (
    select e.*,row_number() over(order by e.score desc,e.sort_date desc,e.article_id) as row_number
    from eligible e
    order by e.score desc,e.sort_date desc,e.article_id
    limit p_limit+1
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id',article_id,'score',score,'matchType',matched_by,
      'enrichmentStatus',enrichment_status,'enrichmentFreshness',enrichment_freshness,
      'summaryStatus',summary_status,'summaryAvailable',summary_available
    ) order by row_number) filter(where row_number<=p_limit),'[]'::jsonb),
    count(*)::integer,
    (jsonb_agg(jsonb_build_object(
      'score',score,'sortDate',sort_date,'articleId',article_id,'mode',matched_by
    ) order by row_number desc) filter(where row_number<=p_limit))->0
  into v_entries,v_page_count,v_last
  from page;

  v_returned:=least(v_page_count,p_limit);
  v_has_more:=v_page_count>p_limit;
  if v_returned>0 then v_mode:=v_entries->0->>'matchType';
  elsif v_cursor_mode is not null then v_mode:=v_cursor_mode;
  elsif v_query='' then v_mode:='latest';
  else v_mode:='lexical'; end if;

  if p_cursor is not null and v_page_count>0 and v_mode<>v_cursor_mode then
    raise exception using errcode='22023',message='WORLDCONS_CASE_SEARCH_CURSOR_MODE_CHANGED';
  end if;

  return jsonb_build_object(
    'schemaVersion',2,
    'rankingVersion','gate3-exact-lexical-v1',
    'entries',v_entries,
    'retrievalMode',v_mode,
    'nextCursor',case when v_has_more then worldcons_case_search_cursor_encode_v1(
      v_fingerprint,v_last->>'mode',(v_last->>'score')::double precision,
      (v_last->>'sortDate')::timestamptz,(v_last->>'articleId')::uuid,v_position+v_returned
    ) else null end,
    'total',v_position+v_returned+case when v_has_more then 1 else 0 end,
    'hasMore',v_has_more,
    'totalIsExact',not v_has_more
  );
end;
$function$;

revoke all on public_case_search_documents_v1 from public;
revoke all on function worldcons_case_search_fingerprint_v1(text,text,text,text,text,text,text) from public;
revoke all on function worldcons_case_search_cursor_encode_v1(text,text,double precision,timestamptz,uuid,bigint) from public;
revoke all on function worldcons_case_search_cursor_decode_v1(text) from public;
revoke all on function worldcons_case_search_ranked_v1(text,text,text,text,text,text,text) from public;
revoke all on function worldcons_case_search_page_v2(text,integer,text,text,text,text,text,text,text) from public;

do $permissions$
begin
  if exists(select 1 from pg_roles where rolname='anon') then
    revoke all on public_case_search_documents_v1 from anon;
    revoke all on function worldcons_case_search_page_v2(text,integer,text,text,text,text,text,text,text) from anon;
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    revoke all on public_case_search_documents_v1 from authenticated;
    revoke all on function worldcons_case_search_page_v2(text,integer,text,text,text,text,text,text,text) from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select on public_case_search_documents_v1 to service_role;
    grant execute on function worldcons_case_search_page_v2(text,integer,text,text,text,text,text,text,text) to service_role;
  end if;
end;
$permissions$;

comment on view public_case_search_documents_v1 is
  'One fail-closed representative search document per public article: current P3 or authoritative Catalog fallback.';
comment on function worldcons_case_search_page_v2(text,integer,text,text,text,text,text,text,text) is
  'Gate 3 identifier-first and lexical constitutional case search with deterministic keyset cursors.';

notify pgrst,'reload schema';
commit;
