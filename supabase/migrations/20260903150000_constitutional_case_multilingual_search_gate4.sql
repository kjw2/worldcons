begin;

create or replace function worldcons_legal_alias_normalize_v1(p_value text)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $function$
  select translate(
    regexp_replace(lower(trim(coalesce(p_value,''))),'[[:space:]]+','','g'),
    $punct$._-/#,;:()[]{}'"$punct$,
    ''
  )
$function$;

-- A reviewed alias set is an immutable ranking input. Search always selects the
-- most recently reviewed set and binds its version into every cursor. Draft
-- rows are intentionally invisible to public retrieval.
create table legal_concept_alias_sets_v1 (
  id uuid primary key default gen_random_uuid(),
  set_version text not null unique,
  status text not null default 'draft',
  provenance text not null,
  content_hash text,
  reviewed_by text,
  reviewed_at timestamptz,
  supersedes_alias_set_id uuid references legal_concept_alias_sets_v1(id),
  created_at timestamptz not null default now(),
  constraint legal_concept_alias_sets_v1_version_check
    check (set_version ~ '^[a-z0-9][a-z0-9._-]{2,79}$'),
  constraint legal_concept_alias_sets_v1_status_check
    check (status in ('draft','reviewed')),
  constraint legal_concept_alias_sets_v1_review_check check (
    (status='draft' and reviewed_by is null and reviewed_at is null and content_hash is null)
    or
    (status='reviewed' and reviewed_by is not null and reviewed_at is not null and content_hash ~ '^[0-9a-f]{64}$')
  )
);

create table legal_concepts_v1 (
  id uuid primary key default gen_random_uuid(),
  alias_set_id uuid not null references legal_concept_alias_sets_v1(id) on delete restrict,
  stable_key text not null,
  label_ko text not null,
  definition text,
  status text not null default 'active',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  unique(alias_set_id,stable_key),
  unique(id,alias_set_id),
  constraint legal_concepts_v1_key_check check (stable_key ~ '^[a-z0-9][a-z0-9._-]{1,79}$'),
  constraint legal_concepts_v1_status_check check (status in ('active','retired')),
  constraint legal_concepts_v1_version_check check (version>0),
  constraint legal_concepts_v1_label_check check (length(trim(label_ko)) between 1 and 200)
);

create table legal_concept_aliases_v1 (
  id uuid primary key default gen_random_uuid(),
  alias_set_id uuid not null references legal_concept_alias_sets_v1(id) on delete restrict,
  concept_id uuid not null,
  language text not null,
  raw_alias text not null,
  normalized_alias text not null,
  alias_type text not null,
  provenance text not null,
  review_status text not null default 'pending',
  created_at timestamptz not null default now(),
  foreign key(concept_id,alias_set_id) references legal_concepts_v1(id,alias_set_id) on delete restrict,
  unique(alias_set_id,language,normalized_alias,concept_id),
  constraint legal_concept_aliases_v1_language_check check (language in ('ko','en','de','fr','es')),
  constraint legal_concept_aliases_v1_type_check
    check (alias_type in ('preferred','synonym','translated','acronym','historical')),
  constraint legal_concept_aliases_v1_review_check check (review_status in ('pending','approved','rejected')),
  constraint legal_concept_aliases_v1_raw_check check (length(trim(raw_alias)) between 2 and 160),
  constraint legal_concept_aliases_v1_normalized_check
    check (normalized_alias=worldcons_legal_alias_normalize_v1(raw_alias) and length(normalized_alias)>=2)
);

create index legal_concept_alias_sets_v1_reviewed_idx
  on legal_concept_alias_sets_v1(reviewed_at desc,id desc) where status='reviewed';
create index legal_concept_aliases_v1_lookup_idx
  on legal_concept_aliases_v1(alias_set_id,normalized_alias,concept_id)
  where review_status='approved';
create index legal_concept_aliases_v1_concept_idx
  on legal_concept_aliases_v1(alias_set_id,concept_id,language,alias_type)
  where review_status='approved';

create or replace function worldcons_legal_alias_child_guard_v1()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
declare
  v_old_set uuid;
  v_new_set uuid;
begin
  v_old_set:=case when tg_op in ('UPDATE','DELETE') then old.alias_set_id else null end;
  v_new_set:=case when tg_op in ('INSERT','UPDATE') then new.alias_set_id else null end;
  if (v_old_set is not null and exists(
      select 1 from legal_concept_alias_sets_v1 where id=v_old_set and status='reviewed'
    )) or (v_new_set is not null and exists(
      select 1 from legal_concept_alias_sets_v1 where id=v_new_set and status='reviewed'
    )) then
    raise exception using errcode='55000',message='WORLDCONS_REVIEWED_ALIAS_SET_IMMUTABLE';
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$function$;

create trigger legal_concepts_v1_reviewed_guard
before insert or update or delete on legal_concepts_v1
for each row execute function worldcons_legal_alias_child_guard_v1();
create trigger legal_concept_aliases_v1_reviewed_guard
before insert or update or delete on legal_concept_aliases_v1
for each row execute function worldcons_legal_alias_child_guard_v1();

create or replace function worldcons_legal_alias_set_guard_v1()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $function$
declare
  v_hash text;
begin
  if tg_op='DELETE' or old.status='reviewed' then
    raise exception using errcode='55000',message='WORLDCONS_REVIEWED_ALIAS_SET_IMMUTABLE';
  end if;
  if new.status='reviewed' then
    if new.reviewed_by is null or new.reviewed_at is null then
      raise exception using errcode='23514',message='WORLDCONS_ALIAS_SET_REVIEW_REQUIRED';
    end if;
    if not exists(
      select 1 from legal_concepts_v1 c
      join legal_concept_aliases_v1 a on a.alias_set_id=c.alias_set_id and a.concept_id=c.id
      where c.alias_set_id=old.id and c.status='active' and a.review_status='approved'
    ) or exists(
      select 1 from legal_concepts_v1 c
      where c.alias_set_id=old.id and c.status='active' and (
        select count(*) from legal_concept_aliases_v1 a
        where a.alias_set_id=c.alias_set_id and a.concept_id=c.id and a.review_status='approved'
      )<2
    ) then
      raise exception using errcode='23514',message='WORLDCONS_ALIAS_SET_INCOMPLETE';
    end if;
    select encode(extensions.digest(convert_to(coalesce(string_agg(
      concat_ws(chr(31),c.stable_key,c.label_ko,c.status,c.version::text,
        a.language,a.normalized_alias,a.alias_type,a.provenance,a.review_status),chr(30)
      order by c.stable_key,a.language,a.normalized_alias,a.alias_type
    ),''),'UTF8'),'sha256'),'hex')
    into v_hash
    from legal_concepts_v1 c
    join legal_concept_aliases_v1 a on a.alias_set_id=c.alias_set_id and a.concept_id=c.id
    where c.alias_set_id=old.id;
    new.content_hash:=v_hash;
  else
    new.content_hash:=null;
    new.reviewed_by:=null;
    new.reviewed_at:=null;
  end if;
  return new;
end;
$function$;

create trigger legal_concept_alias_sets_v1_review_guard
before update or delete on legal_concept_alias_sets_v1
for each row execute function worldcons_legal_alias_set_guard_v1();

create or replace function worldcons_case_search_ranking_version_v2()
returns text
language sql
stable
security definer
set search_path = public, extensions, pg_temp
set statement_timeout = '500ms'
as $function$
  select 'gate4-multilingual-rrf-v1:'||coalesce((
    select s.set_version||':'||left(s.content_hash,12)
    from legal_concept_alias_sets_v1 s
    where s.status='reviewed'
    order by s.reviewed_at desc,s.id desc
    limit 1
  ),'none')
$function$;

create or replace function worldcons_case_search_fingerprint_v2(
  p_query text,
  p_source text,
  p_jurisdiction text,
  p_content_type text,
  p_language text,
  p_tag text,
  p_range text,
  p_ranking_version text
)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $function$
  select encode(extensions.digest(convert_to(concat_ws(chr(31),
    lower(trim(coalesce(p_query,''))),coalesce(p_source,''),coalesce(p_jurisdiction,''),
    coalesce(p_content_type,''),coalesce(p_language,''),coalesce(p_tag,''),
    coalesce(p_range,'latest'),p_ranking_version
  ),'UTF8'),'sha256'),'hex')
$function$;

create or replace function worldcons_case_search_cursor_encode_v2(
  p_ranking_version text,
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
    'rankingVersion',p_ranking_version,'fingerprint',p_fingerprint,'mode',p_mode,
    'score',p_score,'sortDate',p_sort_date,'articleId',p_article_id,'position',p_position
  )::text,'UTF8'),'base64'),'='),E'\n',''),E'\r',''),'+/','-_')
$function$;

create or replace function worldcons_case_search_cursor_decode_v2(p_cursor text)
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
    or coalesce(v_payload->>'rankingVersion',v_payload->>'version') is null
    or v_payload->>'mode' not in ('exact-identity','lexical','rrf','latest')
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

create or replace function worldcons_case_search_ranked_v2(
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
      worldcons_legal_alias_normalize_v1(p_query) as normalized_query,
      worldcons_query_case_reference_v1(p_query) as case_reference
  ), active_alias_set as (
    select s.id
    from legal_concept_alias_sets_v1 s
    where s.status='reviewed'
    order by s.reviewed_at desc,s.id desc
    limit 1
  ), filtered as materialized (
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
  ), detected_concepts as materialized (
    select c.id,c.stable_key,
      max(case when a.normalized_alias=i.normalized_query then 2 else 1 end) as match_strength
    from active_alias_set s
    join legal_concepts_v1 c on c.alias_set_id=s.id and c.status='active'
    join legal_concept_aliases_v1 a on a.alias_set_id=s.id and a.concept_id=c.id and a.review_status='approved'
    cross join input i
    where i.normalized_query<>'' and (
      a.normalized_alias=i.normalized_query
      or (length(a.normalized_alias)>=3 and position(a.normalized_alias in i.normalized_query)>0)
    )
    group by c.id,c.stable_key
    order by match_strength desc,c.stable_key
    limit 5
  ), alias_terms as materialized (
    select concept_id,raw_alias,normalized_alias
    from (
      select a.concept_id,a.raw_alias,a.normalized_alias,
        row_number() over(partition by a.concept_id order by
          case a.alias_type when 'preferred' then 1 when 'synonym' then 2
            when 'translated' then 3 when 'acronym' then 4 else 5 end,
          a.language,a.normalized_alias
        ) as concept_alias_rank
      from detected_concepts c
      join legal_concept_aliases_v1 a on a.concept_id=c.id and a.review_status='approved'
      cross join input i
      where a.normalized_alias<>i.normalized_query
    ) bounded_per_concept
    where concept_alias_rank<=8
    order by concept_id,concept_alias_rank
    limit 12
  ), strategy as (
    select case
      when exists(select 1 from exact_candidates) then 'exact-identity'
      when (select query_text from input)='' then 'latest'
      else 'rrf'
    end as mode
  ), original_hits as materialized (
    select d.id,
      row_number() over(order by
        (ts_rank_cd(d.search_vector,websearch_to_tsquery('simple',i.query_text),32)
          + case when lower(regexp_replace(trim(coalesce(d.korean_title,'')),'[[:space:]]+',' ','g'))=lower(regexp_replace(i.query_text,'[[:space:]]+',' ','g'))
            or lower(regexp_replace(trim(coalesce(d.original_title,'')),'[[:space:]]+',' ','g'))=lower(regexp_replace(i.query_text,'[[:space:]]+',' ','g')) then 10 else 0 end) desc,
        d.original_published_at desc nulls last,d.id
      ) as branch_rank
    from filtered d cross join input i
    where (select mode from strategy)='rrf'
      and d.search_vector is not null
      and d.search_vector@@websearch_to_tsquery('simple',i.query_text)
    limit 50
  ), alias_hits as materialized (
    select hit.id,t.concept_id,t.normalized_alias,hit.branch_rank
    from alias_terms t
    cross join lateral (
      select d.id,
        row_number() over(order by
          ts_rank_cd(d.search_vector,plainto_tsquery('simple',t.raw_alias),32) desc,
          d.original_published_at desc nulls last,d.id
        ) as branch_rank
      from filtered d
      where (select mode from strategy)='rrf'
        and d.search_vector is not null
        and d.search_vector@@plainto_tsquery('simple',t.raw_alias)
      order by ts_rank_cd(d.search_vector,plainto_tsquery('simple',t.raw_alias),32) desc,
        d.original_published_at desc nulls last,d.id
      limit 50
    ) hit
  ), alias_contributions as (
    -- Several translations of the same concept are recall branches, not
    -- independent votes. Cap alias-only evidence at one RRF contribution so
    -- it can never outrank even the 50th original-query candidate by itself.
    select id,max(1.0::double precision/(60+branch_rank)::double precision) as contribution
    from alias_hits
    group by id
  ), rrf_contributions as (
    select id,2.0::double precision/(60+branch_rank)::double precision as contribution
    from original_hits
    union all
    select id,contribution from alias_contributions
  ), fused_unbounded as (
    select d.id,d.jurisdiction,
      sum(c.contribution)::double precision as fused_score,
      coalesce(d.original_published_at,'0001-01-01 00:00:00+00'::timestamptz) as sort_date,
      d.enrichment_status,d.enrichment_freshness,d.summary_status,d.summary_available
    from rrf_contributions c join filtered d on d.id=c.id
    group by d.id,d.jurisdiction,d.original_published_at,d.enrichment_status,
      d.enrichment_freshness,d.summary_status,d.summary_available
  ), fused as materialized (
    select * from fused_unbounded
    order by fused_score desc,sort_date desc,id
    limit 250
  ), diversity_ranked as (
    select f.*,
      row_number() over(partition by coalesce(f.jurisdiction,'') order by f.fused_score desc,f.sort_date desc,f.id) as jurisdiction_rank
    from fused f
  ), diversified as (
    -- Never boost a weak candidate. A small demotion after two results from the
    -- same jurisdiction only lets an already close alternative move upward.
    select d.*,
      (d.fused_score*case when d.jurisdiction_rank<=2 then 1.0 else 0.92 end)::double precision as final_score
    from diversity_ranked d
  ), ranked as (
    select d.id as article_id,e.identity_score as score,
      coalesce(d.original_published_at,'0001-01-01 00:00:00+00'::timestamptz) as sort_date,
      'exact-identity'::text as matched_by,d.enrichment_status,d.enrichment_freshness,
      d.summary_status,d.summary_available
    from exact_candidates e join filtered d on d.id=e.id
    where (select mode from strategy)='exact-identity'
    union all
    select d.id,d.final_score,d.sort_date,'rrf'::text,
      d.enrichment_status,d.enrichment_freshness,d.summary_status,d.summary_available
    from diversified d
    where (select mode from strategy)='rrf' and d.final_score>0
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
  v_ranking_version text:=worldcons_case_search_ranking_version_v2();
  v_fingerprint text;
  v_cursor jsonb;
  v_cursor_score double precision;
  v_cursor_date timestamptz;
  v_cursor_id uuid;
  v_cursor_mode text;
  v_cursor_ranking_version text;
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

  v_fingerprint:=worldcons_case_search_fingerprint_v2(
    v_query,p_source,p_jurisdiction,p_content_type,p_language,p_tag,p_range,v_ranking_version
  );
  if p_cursor is not null then
    v_cursor:=worldcons_case_search_cursor_decode_v2(p_cursor);
    v_cursor_ranking_version:=coalesce(v_cursor->>'rankingVersion',v_cursor->>'version');
    if v_cursor_ranking_version is distinct from v_ranking_version then
      raise exception using errcode='22023',message='WORLDCONS_CASE_SEARCH_CURSOR_RANKING_VERSION_EXPIRED';
    end if;
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
    from worldcons_case_search_ranked_v2(
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
  else v_mode:='rrf'; end if;

  if p_cursor is not null and v_page_count>0 and v_mode<>v_cursor_mode then
    raise exception using errcode='22023',message='WORLDCONS_CASE_SEARCH_CURSOR_MODE_CHANGED';
  end if;

  return jsonb_build_object(
    'schemaVersion',2,
    'rankingVersion',v_ranking_version,
    'entries',v_entries,
    'retrievalMode',v_mode,
    'nextCursor',case when v_has_more then worldcons_case_search_cursor_encode_v2(
      v_ranking_version,v_fingerprint,v_last->>'mode',(v_last->>'score')::double precision,
      (v_last->>'sortDate')::timestamptz,(v_last->>'articleId')::uuid,v_position+v_returned
    ) else null end,
    'total',v_position+v_returned+case when v_has_more then 1 else 0 end,
    'hasMore',v_has_more,
    'totalIsExact',not v_has_more
  );
end;
$function$;

revoke all on legal_concept_alias_sets_v1,legal_concepts_v1,legal_concept_aliases_v1 from public;
revoke all on function worldcons_legal_alias_normalize_v1(text) from public;
revoke all on function worldcons_case_search_ranking_version_v2() from public;
revoke all on function worldcons_case_search_fingerprint_v2(text,text,text,text,text,text,text,text) from public;
revoke all on function worldcons_case_search_cursor_encode_v2(text,text,text,double precision,timestamptz,uuid,bigint) from public;
revoke all on function worldcons_case_search_cursor_decode_v2(text) from public;
revoke all on function worldcons_case_search_ranked_v2(text,text,text,text,text,text,text) from public;
revoke all on function worldcons_case_search_page_v2(text,integer,text,text,text,text,text,text,text) from public;

do $permissions$
begin
  if exists(select 1 from pg_roles where rolname='anon') then
    revoke all on legal_concept_alias_sets_v1,legal_concepts_v1,legal_concept_aliases_v1 from anon;
    revoke all on function worldcons_case_search_page_v2(text,integer,text,text,text,text,text,text,text) from anon;
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    revoke all on legal_concept_alias_sets_v1,legal_concepts_v1,legal_concept_aliases_v1 from authenticated;
    revoke all on function worldcons_case_search_page_v2(text,integer,text,text,text,text,text,text,text) from authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select on legal_concept_alias_sets_v1,legal_concepts_v1,legal_concept_aliases_v1 to service_role;
    grant execute on function worldcons_case_search_ranking_version_v2() to service_role;
    grant execute on function worldcons_case_search_page_v2(text,integer,text,text,text,text,text,text,text) to service_role;
  end if;
end;
$permissions$;

comment on table legal_concept_alias_sets_v1 is
  'Immutable reviewed snapshots of multilingual legal concepts used as versioned search ranking inputs.';
comment on function worldcons_case_search_page_v2(text,integer,text,text,text,text,text,text,text) is
  'Gate 4 identity-first, bounded multilingual alias RRF search with relevance-preserving jurisdiction diversification and versioned keyset cursors.';

notify pgrst,'reload schema';
commit;
