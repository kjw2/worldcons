begin;

-- Artifact Blob contract hardening (corrective, pre-production only).
--
-- Production review of the artifact Blob lifecycle (M1 storage contract, M4A
-- externalization, M4B inline clear, M5 readiness) found two schema defects that
-- must be fixed before this migration set is rolled out. This migration is a
-- pure forward corrective: it edits no earlier migration, adds no data, performs
-- no DML, performs no Blob or network access, performs no maintenance, and
-- changes no grant. Both statements only rewrite catalog metadata (an attnotnull
-- bit and a new constraint) and neither rewrites a table, so the hardening is
-- safe to apply pre-production.
--
-- Defect 1: source_normalization_artifacts.normalized_output is still declared
-- NOT NULL from the Gate 1 schema, but the M4B inline clear
-- (20260919110000_artifact_blob_inline_clear.sql) sets normalized_output = null
-- once the document is durably externalized, and the externalized-only state is
-- a required steady state. Dropping NOT NULL makes that state representable.
-- Coherence is unchanged and still enforced: the existing
-- source_normalization_artifacts_json_check only accepts a null normalized_output
-- together with a present normalized_output_storage_ref, and
-- source_normalization_artifacts_externalization_contract_check then requires the
-- full externalized metadata (ref, size, externalized_at, contract version)
-- alongside it. No existing row content is read or written by this migration.
--
-- Defect 2: the Gate 1 source_fetch_artifacts_replay_check bounded
-- bounded_replay_payload at 4 MiB, but the M1 storage contract
-- (20260918100000_artifact_blob_storage_contract.sql) replaced that check without
-- the size bound, so an oversized inline replay payload could be stored again.
-- The bound is restored here as a separate CHECK, so the replay/ref/contract
-- checks are never dropped or rebuilt and a null (externalized-only) payload stays
-- valid. It is added NOT VALID and then validated, so the one-time verification
-- scan does not hold an exclusive lock on the table for its whole duration.

-- Defect 1 correction: allow the externalized-only state. NULL is only coherent
-- with a present normalized_output_storage_ref plus externalization metadata, which
-- the existing checks above continue to enforce.
alter table source_normalization_artifacts
  alter column normalized_output drop not null;

-- Defect 2 correction: restore the 4 MiB inline bound as an independent CHECK so
-- null/externalized-only rows remain valid and no unrelated check is rebuilt.
alter table source_fetch_artifacts
  add constraint source_fetch_artifacts_bounded_replay_payload_size_check
  check (bounded_replay_payload is null or pg_column_size(bounded_replay_payload) <= 4194304)
  not valid;

alter table source_fetch_artifacts
  validate constraint source_fetch_artifacts_bounded_replay_payload_size_check;

comment on constraint source_fetch_artifacts_bounded_replay_payload_size_check on source_fetch_artifacts is
  'Restores the Gate 1 4 MiB inline bound for bounded_replay_payload that the M1 replay check dropped; a null (externalized-only) payload is always valid.';

commit;
