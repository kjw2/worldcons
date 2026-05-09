create or replace function match_articles(
  query_embedding vector(1536),
  match_count integer default 20,
  source_filter text default null,
  jurisdiction_filter text default null,
  content_type_filter text default null,
  language_filter text default null
)
returns table (
  article_id uuid,
  similarity double precision
)
language sql stable
as $$
  select
    a.id as article_id,
    1 - (a.embedding <=> query_embedding) as similarity
  from articles a
  where a.embedding is not null
    and (source_filter is null or a.source_key = source_filter)
    and (jurisdiction_filter is null or a.jurisdiction = jurisdiction_filter)
    and (content_type_filter is null or a.content_type = content_type_filter)
    and (language_filter is null or a.original_language = language_filter)
    and a.status = 'summarized'
    and (a.source_metadata #>> '{collection,publishable}') = 'true'
  order by a.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 500);
$$;

insert into glossary_terms (
  slug,
  term,
  korean_term,
  definition,
  jurisdiction,
  related_tags
) values
(
  'proportionality',
  'Proportionality',
  '비례원칙',
  '기본권 제한이 목적의 정당성, 수단의 적합성, 최소침해성, 법익균형을 충족해야 한다는 심사 구조다.',
  null,
  array['비례원칙']
),
(
  'qpc',
  'Question prioritaire de constitutionnalité',
  '우선적 위헌심사절차',
  '프랑스에서 재판 계속 중 법률 조항의 헌법합치성을 사후적으로 다투는 절차다.',
  'France',
  array['QPC', 'Article 61-1']
),
(
  'standing',
  'Standing',
  '당사자적격',
  '미국 연방법원에서 원고가 구체적 손해, 인과관계, 구제가능성을 보여야 본안 판단을 받을 수 있다는 사법심사 요건이다.',
  'United States',
  array['Standing', 'Article III']
),
(
  'constitutional-complaint',
  'Verfassungsbeschwerde',
  '헌법소원',
  '독일에서 공권력 행사로 기본권이 침해되었다고 주장하는 개인 등이 연방헌법재판소에 제기할 수 있는 권리구제 절차다.',
  'Germany',
  array['Verfassungsbeschwerde', '기본권']
)
on conflict (slug) do update set
  term = excluded.term,
  korean_term = excluded.korean_term,
  definition = excluded.definition,
  jurisdiction = excluded.jurisdiction,
  related_tags = excluded.related_tags,
  updated_at = now();
