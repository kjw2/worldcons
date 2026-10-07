-- @d1-verify {"type":"table","name":"articles","sqlIncludes":["translation_status text not null default 'not_required'","translation_started_at text","translated_at text","translation_provider text","translation_model text","translation_attempt_count integer not null default 0","translation_error_code text","translation_error_summary text","translation_next_attempt_at text"]}
-- @d1-verify {"type":"index","name":"articles_translation_queue_idx","sqlIncludes":["index articles_translation_queue_idx","on articles","(translation_status, translation_next_attempt_at, created_at, id)"]}

ALTER TABLE articles ADD COLUMN translation_status text NOT NULL DEFAULT 'not_required'
  CHECK (translation_status IN ('not_required','pending','running','translated','failed'));
ALTER TABLE articles ADD COLUMN translation_started_at text;
ALTER TABLE articles ADD COLUMN translated_at text;
ALTER TABLE articles ADD COLUMN translation_provider text;
ALTER TABLE articles ADD COLUMN translation_model text;
ALTER TABLE articles ADD COLUMN translation_attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE articles ADD COLUMN translation_error_code text;
ALTER TABLE articles ADD COLUMN translation_error_summary text;
ALTER TABLE articles ADD COLUMN translation_next_attempt_at text;

CREATE INDEX IF NOT EXISTS articles_translation_queue_idx
  ON articles (translation_status, translation_next_attempt_at, created_at, id);

-- Existing summarized foreign-language rows already passed the legacy combined
-- Gemini Korean-enrichment step. Preserve them as completed during the split.
UPDATE articles
SET translation_status='translated',
    translated_at=COALESCE(summarized_at,updated_at),
    translation_provider=COALESCE(json_extract(summary_json,'$.aiMetadata.provider'),'legacy'),
    translation_model=json_extract(summary_json,'$.aiMetadata.model')
WHERE status='summarized'
  AND summary_json IS NOT NULL
  AND lower(COALESCE(original_language,'')) <> 'ko';

-- Private foreign-language source text enters the quota-paced translation queue.
UPDATE articles
SET translation_status='pending',
    translation_next_attempt_at=NULL,
    translation_error_code=NULL,
    translation_error_summary=NULL
WHERE status IN ('cleaned','failed_summary')
  AND summarized_at IS NULL
  AND cleaned_text IS NOT NULL
  AND length(trim(cleaned_text)) >= 500
  AND lower(COALESCE(original_language,'')) <> 'ko';
