begin;

create or replace function case_catalog_bverfg_official_url_valid_v1(
  p_url text,
  p_decision_date date
)
returns boolean
language sql
immutable
set search_path = public, extensions, pg_temp
as $function$
  select coalesce(
    p_url ~ (
      '^https://www[.]bundesverfassungsgericht[.]de/SharedDocs/Entscheidungen/DE/'
      || to_char(p_decision_date,'YYYY') || '/' || to_char(p_decision_date,'MM')
      || '/(rk|rs|qk|qs|cs|ls|es|fs|bs)'
      || to_char(p_decision_date,'YYYYMMDD') || '_[a-z0-9]+[.]html$'
    ),
    false
  );
$function$;

comment on function case_catalog_bverfg_official_url_valid_v1(text,date) is
  'Allows only the reviewed BVerfG official decision filename prefixes for constitutional complaints, interim orders, election disputes, referrals, organ disputes, abstract review, and party bans.';

commit;
