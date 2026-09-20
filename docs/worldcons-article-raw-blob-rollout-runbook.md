# WorldCons article raw-text Blob rollout runbook

Scope: operational rollout of the private article raw-text Blob lifecycle — M6A
contract and flag-on capture, M6B externalization, M6C inline clear, M6D-A operator
read authority, M6D-B read-only aggregate readiness (`article_raw_readiness_v1`)
with optional bounded Blob verification, M6E inline restore
(`article_raw_restore_inline_v1` / `article_raw_restore_candidates_v1`), and the M6F
read-only rollout preflight (`pnpm preflight:article-raw`).

The readiness module (`lib/article-raw/readiness.ts`), repository
(`lib/article-raw/readiness-repository.ts`), and CLI
(`scripts/article-raw-readiness.ts`, `pnpm readiness:article-raw`) are read-only:
they apply no migration, deploy nothing, externalize nothing, clear no inline
raw_text, and run no maintenance. The M6E restore module (`lib/article-raw/restore.ts`),
repository (`lib/article-raw/restore-repository.ts`), and CLI
(`scripts/restore-article-raw-inline.ts`, `pnpm restore:article-raw-inline`) are the
one supported way to put a cleared inline raw_text back; they restore the redundant
inline copy in place, never write or delete a Blob object, and require an explicit
`--execute --acknowledge-inline-restore` together with
`ARTICLE_RAW_BLOB_READ_ENABLED=true`.

The preflight module (`lib/article-raw/rollout-preflight.ts`) and CLI
(`scripts/article-raw-rollout-preflight.ts`, `pnpm preflight:article-raw`) are
read-only: they apply no migration, deploy nothing, never construct a Blob store,
never read/write/delete a Blob object, and mutate nothing. They probe the existing
M6D-A, M6D-B, and M6E read authorities only, and are the static/env check to run
before migrations and the DB-authority/readiness check to run after migrations
(both flags OFF) before enabling READ.

## 1. Invariants

- Both article raw Blob flags stay **default OFF**:
  `ARTICLE_RAW_BLOB_READ_ENABLED=false`, `ARTICLE_RAW_BLOB_WRITE_ENABLED=false`.
  `WRITE` requires `READ`; setting `WRITE` alone is a hard error
  (`flagErrors`), not a silent no-op.
- The readiness module, repository, and CLI are **read-only**. There is no
  `--execute`, no `--acknowledge-*`, and no mutation path. The CLI never calls
  `put`/`delete` and never calls the capture, externalize, or inline-clear RPC.
- The default readiness run is **aggregate-only**. It calls exactly one aggregate
  readiness RPC per selected table (`article_raw_readiness_v1`) and does **zero**
  per-row and **zero** Blob reads. The report never emits storage refs, raw content,
  hashes, sizes, tokens, signed URLs, source keys, row ids, or per-row payloads, and
  it reports `storageRefsEmitted: 0` and `perRowPayloadsEmitted: 0`.
- Blob verification is **off by default** (`--verify-sample=0`). A bare run issues
  zero `head`/`get` calls. It additionally requires the article raw Blob read flag to
  be ready — checked **before** the Blob store is created — so a read-flag-off run
  never even constructs Blob transport, let alone reads.
- When requested, verification reuses the existing **M6D-A operator read authority**
  (`article_raw_operator_candidates_v1`) through the externalization candidate
  repository, pages candidates with the same bounded `--batch-size`/`--max-batches`,
  and selects only **coherent, metadata-complete dual-copy** candidates.
- Inline clear is reversible **only** through the **M6E restore path**
  (`pnpm restore:article-raw-inline`). The M6C guard blocks direct re-population, and
  the M6E restore RPC is the single permit-guarded transition. Do not attempt to
  re-populate inline raw_text with a direct SQL update. The readiness report's
  `inlineRestore: "dedicated_restore_available"` field is a truthful stable marker
  that this restore path exists: readiness stays **read-only** and never restores —
  restore is a separate operation performed by `pnpm restore:article-raw-inline`.
  Restore is **DRY-RUN BY DEFAULT** (zero Blob reads, zero restore RPC calls) and
  execute requires `--acknowledge-inline-restore` plus
  `ARTICLE_RAW_BLOB_READ_ENABLED=true`; `WRITE` is never required.
- The M6E restore module never writes or deletes a Blob object (it never calls
  `put`/`delete`), never repoints externalization metadata, and never touches
  `cleaned_text` or `search_vector`.
- The article raw transport is **provider-selectable but defaults to Vercel**, so
  existing behavior is unchanged. See section 10 for `ARTIFACT_BLOB_PROVIDER`,
  `ARTIFACT_BLOB_BUCKET`, the explicit not-found-only read fallback, and the Vercel
  Hobby Advanced Operations cap warning. Switching providers rewrites no
  `storageRef` value and needs no migration.

## 2. What the readiness report contains

Per table (`articles`, `article_content_versions_p3`) and combined, from one
aggregate RPC per table with an optional `--source` filter:

- `totalRows`, `inlinePresentRows`, `inlineMissingRows`
- `metadataAbsentRows`, `metadataCompleteRows`, `metadataInconsistentRows`
- `externalizedRows` (dual-copy + blob-only), `dualCopyRows`, `blobOnlyRows`,
  `inlineOnlyRows`
- `ledgerCoveredRows` (exact M6B ledger matches), `ledgerMissingOrConflictingRows`
  (metadata-complete rows with **no** exact ledger match; metadata-absent or
  metadata-inconsistent rows never count as a ledger gap)
- `clearableRows` (inline + metadata-complete + exact M6B ledger)
- `inlineBytesEstimated` (the M6A JSON-string document byte estimate)

Optional Blob verification (`--verify-sample=N`, `N` in `0..100`, default `0`)
head/get verifies at most `N` candidates globally and reports aggregate counts only:
`sampled`, `verifiedOk`, `readErrors`, `sizeMismatches`, `hashMismatches`,
`invalidDocuments`, `textMismatches`, plus the per-table sample counts
`sampledByTable.articles` and `sampledByTable.article_content_versions_p3`.

For each selected candidate it performs, in order: `head` size check, `get` byte
length check, SHA-256 check, M6A decode, and a **decoded `text === candidate.rawText`**
check. The global cap is filled fairly: every selected table with `clearableRows > 0`
is attempted **at least once** when capacity permits (so a small `N` cannot starve a
later table), then the remaining slots fill round-robin across tables.

### Gates

- `externalizationReady` (`EXTERNALIZATION_READY`): the read flag is ready **and**
  every selected aggregate RPC succeeded **and returned a non-empty aggregate**
  (`aggregateComplete`) **and** there are no metadata inconsistencies
  (`metadataInconsistentRows == 0`). A selected table whose aggregate read failed
  (`aggregateFailures`) or came back empty (`aggregateEmpty` — an all-zero aggregate,
  for example a source with no `article_content_versions_p3` rows) is missing
  evidence: `aggregateComplete` stays false with an explicit `aggregate_read_failed` /
  `aggregate_empty_<table>` blocking reason, so a `--table=all` run never silently
  under-counts a table that returned no rows.
- `applicationWriteReady` (`APPLICATION_WRITE_READY`): everything
  `EXTERNALIZATION_READY` needs **plus** the write flag ready. `newWriteReady`
  (`NEW_WRITE_READY`) is an **alias** of this gate.
- `inlineClearReady` (`INLINE_CLEAR_READY`): everything `APPLICATION_WRITE_READY`
  needs, plus **full ledger coverage** of every metadata-complete externalized row
  (`ledgerMissingOrConflictingRows === 0`, i.e. no complete row lacks an exact M6B
  ledger match), plus a **requested, non-empty, clean**
  verified sample, plus **per-table sample coverage** — every selected table with
  `clearableRows > 0` must have `sampledByTable[table] > 0`. If `--verify-sample` is
  too small to reach every selected clearable table (or such a table has no coherent
  candidate), the gate stays **not ready** with an explicit blocking reason
  (`verification_clearable_table_unsampled_articles` or
  `verification_clearable_table_unsampled_article_content_versions_p3`);
  `verificationTableCoverageReady` is the corresponding gate flag. A single selected
  table (`--table=articles` / `--table=versions`) only requires its own coverage.
- `critical` is true on any metadata inconsistency or any verification size, hash,
  invalid-document, or **text** mismatch. **Any text mismatch makes readiness
  critical/not-ready.**
- Blob **read errors** do not raise `critical`; they make the verification gate
  **not ready** and block `INLINE_CLEAR_READY`.

## 3. Rollout preflight (M6F)

`pnpm preflight:article-raw` is the read-only preflight. It performs exactly three
bounded reads per carrier table (`articles`, `article_content_versions_p3`) and
nothing else:

- **M6D-A operator candidate read** (`article_raw_operator_candidates_v1`) through the
  externalization candidate repository, **limit 1** per table.
- **M6D-B aggregate readiness read** (`article_raw_readiness_v1`) through the
  readiness repository.
- **M6E restore candidate read** (`article_raw_restore_candidates_v1`) through the
  restore repository, **limit 1** per table.

Every probe goes through the existing repository authority; the preflight never
direct-queries `articles` / `article_content_versions_p3`, never calls an attach,
clear, or restore RPC, never calls `put`/`delete`, and never touches Blob storage. It
reports only booleans, counts, and sanitized error codes — never a storage ref, hash,
size, source key, row id, raw payload, token, or URL. A database outage **fails
closed**: the affected probes are recorded as sanitized error codes, the dependent
gates turn off, and there is no fallback path.

### Preflight gates

- `migrationSafe`: both flags are **OFF** (`READ=false`, `WRITE=false`), there are no
  `flagErrors`, and every allowlisted M6A..M6E migration file **plus the M6G
  corrective artifact Blob hardening migration**
  (`20260919190000_artifact_blob_contract_hardening.sql`) **plus the M6I/GUARD-FIX
  generated-column guard corrective**
  (`20260919200000_article_raw_externalization_guard_generated_columns.sql`) is
  present on disk. Both correctives are mandatory shared prerequisites of the rollout,
  so `migrationSafe` fails closed (all 8 files required) if either is missing.
- The M6I/GUARD-FIX corrective is required **before any version attach, inline clear,
  or inline restore**. It `CREATE OR REPLACE`s only
  `article_raw_externalization_guard_v1`, derives the generated columns dynamically
  from `pg_attribute` for the trigger's own relation, and excludes them from all three
  whole-row identity checks. Without it, the M6E guard compares generated columns
  (for example the `GENERATED ALWAYS STORED` `article_content_versions_p3.case_key`)
  as `OLD`/`NEW` identity operands and raises false
  `ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE` failures on otherwise valid version
  transitions.
- `readEnableSafe`: every DB probe/aggregate succeeded and the combined
  `metadataInconsistentRows` is `0`.
- `writeEnableSafe`: everything `readEnableSafe` needs **plus** READ ready (the READ
  flag is on with no flag errors). Enable READ first, then re-run the preflight.
- `restoreCanarySafe`: every M6E restore probe succeeded **plus** READ ready.
- `clearCanarySafe`: **always false**, with reason
  `runtime_readiness_sample_required`. The M6D-B verified Blob sample and the full
  ledger are still required before any inline clear canary — the preflight never
  substitutes for `INLINE_CLEAR_READY`.

### Preflight CLI and exit codes

```text
# Static/env check before applying migrations. Exit 2 unless migrationSafe.
pnpm preflight:article-raw --require=migration

# DB-authority/readiness check after migrations with both flags OFF. Exit 2 unless
# every probe succeeded and there are no metadata inconsistent rows.
pnpm preflight:article-raw --require=read

# After enabling READ (WRITE still OFF). Exit 2 unless writeEnableSafe / restoreCanarySafe.
pnpm preflight:article-raw --require=write
pnpm preflight:article-raw --require=restore
```

`--require` is optional and repeatable. Exit codes: `0` success, `2` a required gate
was not ready, `1` an unexpected error. A bare run only reports. There is no
`--execute` and no `--acknowledge-*` flag, and the CLI never constructs an
`ArtifactBlobStore`.

## 4. Safe rollout order

Follow this order exactly. Do not skip a step or reorder it.

1. **Preflight (static/env check).** Before applying any migration, run the
   read-only preflight with both flags **OFF**. Exit `2` unless `migrationSafe`
   (both flags OFF, no `flagErrors`, and all 8 allowlisted files — every M6A..M6E
   migration plus the M6G corrective artifact Blob hardening migration
   `20260919190000_artifact_blob_contract_hardening.sql` and the M6I/GUARD-FIX
   generated-column guard corrective
   `20260919200000_article_raw_externalization_guard_generated_columns.sql` — present
   on disk).
   ```text
   pnpm preflight:article-raw --require=migration
   ```
2. **Apply migrations.** Apply the pending article raw migrations (M6A contract,
   M6B externalization, M6C inline clear, M6D-A operator read authority, M6D-B
   read-only aggregate readiness function, and M6E inline restore) to the target
   database. Keep both article raw Blob flags **OFF**. The same pre-production
   migration set also carries the artifact Blob corrective hardening migration
   (`supabase/migrations/20260919190000_artifact_blob_contract_hardening.sql`),
   which makes `source_normalization_artifacts.normalized_output` nullable and
   restores the 4 MiB `source_fetch_artifacts.bounded_replay_payload` inline bound.
   It only alters those two artifact tables, performs no DML, Blob/network access,
   maintenance, or grant, and never touches the article raw carriers. The set also
   carries the **mandatory** M6I/GUARD-FIX generated-column guard corrective
   (`supabase/migrations/20260919200000_article_raw_externalization_guard_generated_columns.sql`),
   which `CREATE OR REPLACE`s only `article_raw_externalization_guard_v1` to exclude
   generated columns from the M6E guard's whole-row identity checks. Apply it before
   any version attach, inline clear, or inline restore, or those transitions fail
   closed with a false `ARTICLE_RAW_EXTERNALIZATION_IMMUTABLE`; it edits no earlier
   migration, recreates no trigger, changes no grant/ACL, performs no DML, and does no
   table rewrite or compaction.
3. **Preflight (DB authority/readiness check).** After the migrations are applied and
   while both flags are still **OFF**, run the preflight again. Exit `2` unless
   `readEnableSafe` (every DB probe/aggregate succeeded and the combined
   `metadataInconsistentRows` is `0`). This proves the M6D-A, M6D-B, and M6E read
   authorities resolve before READ is enabled.
   ```text
   pnpm preflight:article-raw --require=read
   ```
4. **Read-only readiness.** Run the readiness CLI with verification off and both
   flags off. Confirm the report is coherent (`totalRows`,
   `metadataInconsistentRows`, ledger coverage) and that zero Blob reads happened.
   ```text
   pnpm readiness:article-raw
   pnpm readiness:article-raw --table=all
   pnpm readiness:article-raw --table=articles --source=<source-key>
   pnpm readiness:article-raw --table=versions --source=<source-key>
   ```
   `--table` accepts `articles`, `versions` (alias for
   `article_content_versions_p3`), or `all` (the default). If the report shows
   `gates.aggregateComplete === false` (with the failed tables in
   `gates.aggregateFailures` and the empty carriers in `gates.aggregateEmpty`), the
   aggregate RPC did not return a usable, non-empty row for one or more selected
   tables; treat the gates as not-ready and investigate before proceeding.
5. **Enable READ.** Set `ARTICLE_RAW_BLOB_READ_ENABLED=true` in a bounded
   process/session only. `WRITE` stays OFF. Confirm
   `EXTERNALIZATION_READY = true`. Now that READ is ready, confirm the preflight
   write/restore gates before touching them.
   ```text
   pnpm preflight:article-raw --require=write
   pnpm preflight:article-raw --require=restore
   ```
6. **Canary reads.** Run the readiness CLI with a small verification sample and
   confirm `readErrors`, `sizeMismatches`, `hashMismatches`, `invalidDocuments`, and
   `textMismatches` are all zero for the sampled candidates. The sample must be large
   enough to reach every selected clearable table (check `sampledByTable.articles` and
   `sampledByTable.article_content_versions_p3`); if it is not, `INLINE_CLEAR_READY`
   stays false with a `verification_clearable_table_unsampled_<table>` reason. Raise
   `--verify-sample` (and/or narrow `--table`) until both clearable tables are
   covered.
   ```text
   pnpm readiness:article-raw --source=<source-key> --verify-sample=10
   ```
7. **Enable WRITE.** Set `ARTICLE_RAW_BLOB_WRITE_ENABLED=true` (requires READ on).
   Re-run readiness and require `APPLICATION_WRITE_READY = true` (and the
   `NEW_WRITE_READY` alias) with no metadata inconsistencies before proceeding.
8. **M6B dry-run, then execute small batches.** Plan first, then externalize a
   small bounded batch while preserving inline raw_text.
   ```text
   pnpm externalize:article-raw --table=articles --source=<source-key> --batch-size=25
   pnpm externalize:article-raw --table=articles --source=<source-key> --batch-size=25 --execute --acknowledge-externalization
   ```
9. **Recheck readiness.** Re-run the readiness report. Confirm `dualCopyRows`
   increased, `metadataInconsistentRows` stayed zero, and ledger coverage is complete
   for externalized rows.
10. **M6C dry-run.** Plan the inline clear without mutating anything.
   ```text
   pnpm clear:article-raw-inline --table=articles --source=<source-key> --batch-size=25
   ```
11. **Optional tiny clear canary (only now).** Only if readiness reports
   `INLINE_CLEAR_READY = true`, run a single tiny clear canary on one small
   source/table with an explicit acknowledgement.
   ```text
   pnpm clear:article-raw-inline --table=articles --source=<source-key> --batch-size=1 --execute --acknowledge-inline-clear
   ```
12. **Recheck readiness after the canary.** Confirm the clear moves rows from
    `dualCopyRows` to `blobOnlyRows`; readiness must stay non-critical and
    `INLINE_CLEAR_READY` must remain true before any further clear.
13. **M6E restore dry-run, then a tiny restore canary.** Before any *large-scale* M6C
    inline clear, deploy and test M6E and rehearse restore. Plan first (zero Blob
    reads, zero restore RPC), then restore a single tiny canary batch (see section 5).
    ```text
    pnpm restore:article-raw-inline --table=articles --source=<source-key> --batch-size=25
    pnpm restore:article-raw-inline --table=articles --source=<source-key> --batch-size=1 --execute --acknowledge-inline-restore
    ```
    Do not run a large-scale M6C inline clear until M6E has been deployed and this
    canary has passed.

## 5. M6E restore (the rollback path)

M6E is the only supported way to put a cleared inline `raw_text` back. It reuses the
M6A codec and the M6A read flag, reads the Blob object, and restores the redundant
inline copy through the single permit-guarded `article_raw_restore_inline_v1` RPC.
The M6A/M6B/M6C/M6E article raw migrations include the M6E restore RPCs
(`article_raw_restore_inline_v1`, `article_raw_restore_candidates_v1`); apply the
pending M6E migration with the others in step 2 before rehearsing restore.

- **Dry run is the default** and performs **zero Blob reads and zero restore RPC
  calls**. It lists blob-only candidates through `article_raw_restore_candidates_v1`
  (bounded `--batch-size` `1..100`, `--max-batches`, UUID `--after` cursor) and
  classifies each row's metadata only as `planned`, `conflict`, or `not_ready`.
- **Execute** additionally requires `--acknowledge-inline-restore` and
  `ARTICLE_RAW_BLOB_READ_ENABLED=true`, checked **before** the Blob store is created
  or any RPC runs. `WRITE` is never required.
- For each executable blob-only coherent candidate it validates the exact
  contract/ref/hash/size/`externalized_at` and the content-addressed ref, then heads
  the exact recorded size, gets the exact byte length and SHA-256, and decodes the
  stored JSON string. The decoded text and the exact metadata are passed to the RPC
  with `p_dry_run = false`; the database recomputes the JSON-string document size and
  SHA-256 and requires them to equal the recorded Blob size/hash, so a mismatched,
  truncated, or repointed copy fails closed.
- It **never writes or deletes a Blob object** and never repoints externalization
  metadata (`blobObjectsWritten: 0`, `blobObjectsDeleted: 0`). An identical rerun is
  idempotent.
- Restoring an `articles` row advances its existing `updated_at` (see section 6).

### Ordering rule

Do a **tiny restore canary first**, and only run a **large-scale M6C inline clear
after M6E has been deployed and tested**. The sequence is: deploy M6E, dry-run
restore, then a bounded canary restore on one small source/table.

```text
pnpm restore:article-raw-inline --table=articles --source=<source-key> --batch-size=25
pnpm restore:article-raw-inline --table=articles --source=<source-key> --batch-size=1 --execute --acknowledge-inline-restore
```

## 6. Maintenance and `updated_at`

- **No `VACUUM FULL`.** Do not run `VACUUM FULL` as part of this migration, before or
  after an M6E restore. Bloated inline columns are only reclaimed by a later,
  separately approved Supabase-supported maintenance decision.
- **No `pg_repack`.** Do not run `pg_repack` (or any other table rewrite/compaction
  tool) against `articles` or `article_content_versions_p3` for this migration or for
  an M6E restore. The M6B/M6C/M6E guards forbid rewrites, and a rewrite would break
  the one-way externalization/clear/restore contract.
- **`updated_at` warning.** `public.articles` carries an
  `articles_updated_at_trigger` that sets `updated_at = now()` on every update, so
  the M6B externalization attach, the M6C inline clear, and the M6E restore all bump
  `articles.updated_at`. Do **not** use `articles.updated_at` as an externalization,
  clear, or restore marker, and expect recency-ordered admin views and the
  stale-summarizing heuristics (which key off `updated_at`) to see these rows as
  recently touched. Readiness must be read from `article_raw_readiness_v1`, never
  inferred from `updated_at`.

## 7. Rollout decision gates as evidence

Use the `--require-*` flags so a failed gate fails closed with exit code `2` instead
of being read by eye. These are read-only assertions; they change no state.

```text
# Exit 2 unless the read flag is ready, every aggregate RPC succeeded, and there are
# no metadata inconsistencies.
pnpm readiness:article-raw --require-externalization-ready

# Exit 2 unless EXTERNALIZATION_READY also has the write flag ready.
pnpm readiness:article-raw --require-application-write-ready
pnpm readiness:article-raw --require-new-write-ready

# Exit 2 unless the requested verified sample is clean (including text matches),
# covers every selected clearable table, and externalized ledger coverage is complete.
pnpm readiness:article-raw --source=<source-key> --verify-sample=10 --require-inline-clear-ready
```

Exit codes: `0` success, `1` unexpected error or `critical`, `2` a required gate was
not ready.

## 8. Rollback

- To stop new Blob writes, set `ARTICLE_RAW_BLOB_WRITE_ENABLED=false`. Reads may
  stay on while inline raw_text still exists (dual-copy rows read inline first).
- M6B externalization preserves inline raw_text, so it is reversible by disabling
  the write flag; do not re-point or delete externalization metadata.
- **Inline clear is reversed by the M6E restore path** (`pnpm
  restore:article-raw-inline`, dry-run by default). Once inline raw_text is cleared,
  the private Blob object plus the append-only ledger row are the only copies, and
  M6E is the single permit-guarded way to restore the inline copy. Do not improvise
  restore with a direct SQL update; the M6C guard blocks direct re-population. Do a
  tiny restore canary first, and never run a large-scale M6C clear before M6E has
  been deployed and tested.
- Never delete Blob objects. M6C, M6E, and the readiness CLI never delete Blob objects
  (`blobObjectsDeleted: 0`).
- To change the article raw transport, set `ARTIFACT_BLOB_PROVIDER` (and
  `ARTIFACT_BLOB_BUCKET` when using Supabase) and redeploy; there is no data change
  and no object migration. `ARTIFACT_BLOB_PROVIDER=vercel` returns to the previous
  behavior and `ARTIFACT_BLOB_READ_FALLBACK_ENABLED=false` disables the
  not-found-only read fallback. Never repoint or delete existing `storageRef` values.

## 9. Verification

```text
pnpm typecheck
pnpm lint
pnpm check
pnpm test:article-raw-readiness
pnpm test:article-raw-restore
pnpm test:article-raw-preflight
pnpm test:artifact-blob-provider
```

The fakes-only readiness suite (`tests/article-raw-readiness.test.ts`) proves:
aggregate-only default run with zero per-row and zero Blob reads; aggregate row
mapping and redaction; coherent metadata-complete dual-copy candidate selection;
bounded candidate paging; `readErrors`/`sizeMismatches`/`hashMismatches`/
`invalidDocuments`/`textMismatches` accounting; text mismatch ⇒ critical/not-ready;
Blob read error ⇒ verification gate not-ready (not critical); flags/defaults; fair
per-clearable-table sampling with explicit unsampled-table blocking; and the
`EXTERNALIZATION_READY` / `APPLICATION_WRITE_READY` / `NEW_WRITE_READY` (alias) /
`INLINE_CLEAR_READY` decision gates.

The fakes-only restore suite (`tests/article-raw-blob-restore.test.ts`) proves:
metadata-only `planned`/`conflict`/`not_ready` classification before any Blob
access; dry-run with zero Blob reads and zero restore RPC calls; execute gating on
`--acknowledge-inline-restore` plus `ARTICLE_RAW_BLOB_READ_ENABLED=true` before the
Blob store or any RPC; head/get size/SHA-256/decode failures blocking the restore RPC;
the success path head → get → RPC with no `put`/`delete`; partial and conflicting
metadata blocked; bounded UUID-keyset paging; exact repository RPC names and
arguments; idempotent result mapping; metadata preservation; redaction; and static
assertions over `20260919180000_article_raw_blob_restore.sql` for database-side
JSON-string document size/SHA-256 verification, the exact ledger checks, the
trigger-free `articles` carrier, the combined attach/clear/restore guard, and
service_role-only authority.

The fakes-only preflight suite (`tests/article-raw-rollout-preflight.test.ts`)
proves: both tables probed through the M6D-A / M6D-B / M6E repository authorities
with the candidate limit 1 and the exact RPC arguments; count and metadata
inconsistency reporting; the `migrationSafe` / `readEnableSafe` / `writeEnableSafe` /
`restoreCanarySafe` / `clearCanarySafe` gates (including `writeEnableSafe` and
`restoreCanarySafe` requiring READ ready); `clearCanarySafe` always false with
`runtime_readiness_sample_required`; sanitized error codes and fail-closed probe
failures; the hardcoded 8-file M6A..M6E migration filename allowlist plus the M6G
corrective artifact Blob hardening migration and the M6I/GUARD-FIX generated-column
guard corrective `migrationSafe` prerequisites, with only missing names reported;
report redaction (no refs, hashes, raw text, source keys, or row ids); and static
assertions that the module and CLI never direct-query the raw tables, never construct
a Blob store, never call `put`/`delete`, and take no `--execute`/`--acknowledge-*`
flag.

The fakes-only provider suites (`tests/artifact-blob-provider-fallback.test.ts` and
`tests/artifact-blob-r2-transport.test.ts`) prove the Vercel default, explicit R2
provider, compatibility Supabase provider, R2 S3/Worker-binding transports, strict
object-not-found-only fallback, ordered read fallbacks, primary-only writes, stable
non-secret errors, and the unchanged content-addressed `storageRef` contract. The
same transport applies to artifact and `article_raw` prefixes.

## 10. Artifact Blob provider selection (Vercel / R2 / Supabase compatibility)

The article raw transport shares the artifact `ArtifactBlobStore` and is
provider-selectable and defaults to the current Vercel private Blob store, so an
existing deployment is unchanged until an operator opts in. Provider selection never
changes the `ArtifactBlobStore` contract, the content-addressed `storageRef` contract
(`artifacts/article_raw/{source}/{sha256}.json`), or any existing row, and it needs
no migration.

- `ARTIFACT_BLOB_PROVIDER` — `vercel` (default), `r2`, or compatibility
  `supabase`. New M1 externalization targets R2 only after canary approval.
- `ARTIFACT_BLOB_BUCKET` — private provider bucket, default
  `worldcons-artifacts`; it must already exist.
- Node/CLI R2 access uses `R2_ENDPOINT` or `R2_ACCOUNT_ID` plus
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and optional `R2_REGION=auto`.
  Workers may inject an `R2Bucket` binding.
- Staged operator migrations can instead set
  `ARTIFACT_BLOB_R2_OPERATOR_TRANSPORT=wrangler` with
  `ARTIFACT_BLOB_PROVIDER=r2`. This is a Node maintenance-CLI bridge using the
  local Wrangler OAuth session; it is not an application-runtime credential path.
- `ARTIFACT_BLOB_READ_FALLBACK_PROVIDERS` — ordered read-only fallback list such as
  `vercel`. Unknown, duplicate, or primary-equal entries are rejected.
- `ARTIFACT_BLOB_READ_FALLBACK_ENABLED` — default `false`. When the primary provider
  is non-Vercel and no explicit list exists, legacy `true` means Vercel fallback.

```text
provider=vercel (default)         -> reads and writes use Vercel only
provider=r2                        -> reads and writes use R2 only
provider=r2 + fallbacks=vercel     -> writes:     R2 only
                                      reads/head: R2 first, Vercel on object-not-found only
provider=supabase                  -> compatibility path only
```

No `storageRef` value is rewritten, no object is copied by this change, and no
secret, signed URL, or token is ever placed in a ref or a log line.

### Vercel Hobby Advanced Operations cap

**Warning.** Vercel Blob Hobby "Advanced Operations" are capped at 2,000/month.
Exceeding the cap can suspend the entire private store so that **reads and writes
both fail**, with no overage billing and no self-serve recovery. That is why this
M1 therefore moves new article raw externalization writes to R2 only after a bounded
canary. A suspended Vercel store is an operational failure and must never be treated
as not-found. Never repoint existing `storageRef` values.

### M1 R2 article-raw canary

The first R2 article-raw canary must preserve every inline `raw_text` value:

1. Configure the private R2 bucket/credentials or Worker binding without exposing
   values in logs.
2. Set `ARTIFACT_BLOB_PROVIDER=r2` and choose a single small source/table candidate.
3. Dry-run, then externalize only 1–5 rows. M6B attaches verified refs and keeps
   inline text.
4. Run bounded readiness verification and require R2 GET, exact size/SHA-256 and
   successful JSON-string decode.
5. Run M6E restore in dry-run/rehearsal mode only. Since inline text still exists,
   the first canary does **not** execute clear or restore.
6. Stop on any R2 auth/bucket/signature/network/rate/provider failure.

Do not execute `clear:article-raw-inline` during the first M1 R2 canary.
