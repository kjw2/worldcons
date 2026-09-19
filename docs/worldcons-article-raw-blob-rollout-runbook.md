# WorldCons article raw-text Blob rollout runbook

Scope: operational rollout of the private article raw-text Blob lifecycle — M6A
contract and flag-on capture, M6B externalization, M6C inline clear, M6D-A operator
read authority, M6D-B read-only aggregate readiness (`article_raw_readiness_v1`)
with optional bounded Blob verification, and M6E inline restore
(`article_raw_restore_inline_v1` / `article_raw_restore_candidates_v1`).

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
  re-populate inline raw_text with a direct SQL update. Restore is **DRY-RUN BY
  DEFAULT** (zero Blob reads, zero restore RPC calls) and execute requires
  `--acknowledge-inline-restore` plus `ARTICLE_RAW_BLOB_READ_ENABLED=true`; `WRITE` is
  never required.
- The M6E restore module never writes or deletes a Blob object (it never calls
  `put`/`delete`), never repoints externalization metadata, and never touches
  `cleaned_text` or `search_vector`.

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
  every selected aggregate RPC succeeded (`aggregateComplete`) **and** there are no
  metadata inconsistencies (`metadataInconsistentRows == 0`).
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

## 3. Safe rollout order

Follow this order exactly. Do not skip a step or reorder it.

1. **Apply migrations.** Apply the pending article raw migrations (M6A contract,
   M6B externalization, M6C inline clear, M6D-A operator read authority, and the
   M6D-B read-only aggregate readiness function) to the target database. Keep both
   article raw Blob flags **OFF**.
2. **Read-only readiness.** Run the readiness CLI with verification off and both
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
   `gates.aggregateComplete === false` (with the failing tables in
   `gates.aggregateFailures`), the aggregate RPC did not return a usable row for one
   or more selected tables; treat the gates as not-ready and investigate before
   proceeding.
3. **Enable READ.** Set `ARTICLE_RAW_BLOB_READ_ENABLED=true` in a bounded
   process/session only. `WRITE` stays OFF. Confirm
   `EXTERNALIZATION_READY = true`.
4. **Canary reads.** Run the readiness CLI with a small verification sample and
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
5. **Enable WRITE.** Set `ARTICLE_RAW_BLOB_WRITE_ENABLED=true` (requires READ on).
   Re-run readiness and require `APPLICATION_WRITE_READY = true` (and the
   `NEW_WRITE_READY` alias) with no metadata inconsistencies before proceeding.
6. **M6B dry-run, then execute small batches.** Plan first, then externalize a
   small bounded batch while preserving inline raw_text.
   ```text
   pnpm externalize:article-raw --table=articles --source=<source-key> --batch-size=25
   pnpm externalize:article-raw --table=articles --source=<source-key> --batch-size=25 --execute --acknowledge-externalization
   ```
7. **Recheck readiness.** Re-run the readiness report. Confirm `dualCopyRows`
   increased, `metadataInconsistentRows` stayed zero, and ledger coverage is complete
   for externalized rows.
8. **M6C dry-run.** Plan the inline clear without mutating anything.
   ```text
   pnpm clear:article-raw-inline --table=articles --source=<source-key> --batch-size=25
   ```
9. **Optional tiny clear canary (only now).** Only if readiness reports
   `INLINE_CLEAR_READY = true`, run a single tiny clear canary on one small
   source/table with an explicit acknowledgement.
   ```text
   pnpm clear:article-raw-inline --table=articles --source=<source-key> --batch-size=1 --execute --acknowledge-inline-clear
   ```
10. **Recheck readiness after the canary.** Confirm the clear moves rows from
    `dualCopyRows` to `blobOnlyRows`; readiness must stay non-critical and
    `INLINE_CLEAR_READY` must remain true before any further clear.
11. **M6E restore dry-run, then a tiny restore canary.** Before any *large-scale* M6C
    inline clear, deploy and test M6E and rehearse restore. Plan first (zero Blob
    reads, zero restore RPC), then restore a single tiny canary batch (see section 4).
    ```text
    pnpm restore:article-raw-inline --table=articles --source=<source-key> --batch-size=25
    pnpm restore:article-raw-inline --table=articles --source=<source-key> --batch-size=1 --execute --acknowledge-inline-restore
    ```
    Do not run a large-scale M6C inline clear until M6E has been deployed and this
    canary has passed.

## 4. M6E restore (the rollback path)

M6E is the only supported way to put a cleared inline `raw_text` back. It reuses the
M6A codec and the M6A read flag, reads the Blob object, and restores the redundant
inline copy through the single permit-guarded `article_raw_restore_inline_v1` RPC.
The M6A/M6B/M6C/M6E article raw migrations include the M6E restore RPCs
(`article_raw_restore_inline_v1`, `article_raw_restore_candidates_v1`); apply the
pending M6E migration with the others in step 1 before rehearsing restore.

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
- Restoring an `articles` row advances its existing `updated_at` (see section 5).

### Ordering rule

Do a **tiny restore canary first**, and only run a **large-scale M6C inline clear
after M6E has been deployed and tested**. The sequence is: deploy M6E, dry-run
restore, then a bounded canary restore on one small source/table.

```text
pnpm restore:article-raw-inline --table=articles --source=<source-key> --batch-size=25
pnpm restore:article-raw-inline --table=articles --source=<source-key> --batch-size=1 --execute --acknowledge-inline-restore
```

## 5. Maintenance and `updated_at`

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

## 6. Rollout decision gates as evidence

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

## 7. Rollback

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

## 8. Verification

```text
pnpm typecheck
pnpm lint
pnpm check
pnpm test:article-raw-readiness
pnpm test:article-raw-restore
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
