insert into sources (
  source_key,
  name,
  jurisdiction,
  base_url,
  language,
  is_active
) values (
  'es-tribunal-constitucional',
  'Tribunal Constitucional de España',
  'Spain',
  'https://hj.tribunalconstitucional.es',
  'es',
  true
)
on conflict (source_key) do update
set
  name = excluded.name,
  jurisdiction = excluded.jurisdiction,
  base_url = excluded.base_url,
  language = excluded.language,
  is_active = true,
  updated_at = now();

