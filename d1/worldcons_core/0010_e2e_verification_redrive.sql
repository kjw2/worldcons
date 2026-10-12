-- Preserve the exhausted verifier budget and operator reason before reopening the same approved generation.
-- @d1-verify {"type":"table","name":"e2e_verification_redrive_v1","sqlIncludes":["previous_verification_fence integer not null","previous_state_document text not null","unique(generation_id,previous_verification_fence)"]}
create table if not exists e2e_verification_redrive_v1(
 id text primary key not null, generation_id text not null references e2e_generations_v1(generation_id),
 operator_id text not null, reason text not null, previous_verification_fence integer not null,
 previous_state_document text not null, created_at text not null, unique(generation_id,previous_verification_fence)
);
create index if not exists e2e_verification_redrive_operator_v1 on e2e_verification_redrive_v1(operator_id,created_at);
