# WorldCons article raw-text Blob rollout runbook

Scope: operational rollout of the private article raw-text Blob lifecycle — M6A
contract and flag-on capture, M6B externalization, M6C inline clear, M6D-A operator
read authority, and M6D-B read-only aggregate readiness (`article_raw_readiness_v1`)
with optional bounded Blob verification.

This runbook is read-only guidance. The readiness module
(`lib/article-raw/readiness.ts`), repository
(`lib/article-raw/readiness-repository.ts`), and CLI
(`scripts/article-raw-readiness.ts`, `pnpm readiness:article-raw`) apply no
migration, deploy nothing, externalize nothing, clear no inline raw_text, and run no
maintenance. It introduces no new write authority.

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
- Inline clear is irreversible at the database layer. After any real inline clear,
  restoring the inline copy requires a **separately designed restore path** that is
  intentionally **not implemented** in this milestone. Do not attempt to re-populate
  inline raw_text directly; the M6C guard blocks it.

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

## 4. Maintenance and `updated_at`

- **No `VACUUM FULL`.** Do not run `VACUUM FULL` as part of this migration. Bloated
  inline columns are only reclaimed by a later, separately approved
  Supabase-supported maintenance decision.
- **No `pg_repack`.** Do not run `pg_repack` (or any other table rewrite/compaction
  tool) against `articles` or `article_content_versions_p3` for this migration. The
  M6B/M6C guards forbid rewrites, and a rewrite would break the one-way
  externalization/clear contract.
- **`updated_at` warning.** `public.articles` carries an
  `articles_updated_at_trigger` that sets `updated_at = now()` on every update, so
  both the M6B externalization attach and the M6C inline clear bump
  `articles.updated_at`. Do **not** use `articles.updated_at` as an externalization or
  clear marker, and expect recency-ordered admin views and the stale-summarizing
  heuristics (which key off `updated_at`) to see these rows as recently touched.
  Readiness must be read from `article_raw_readiness_v1`, never inferred from
  `updated_at`.

## 5. Rollout decision gates as evidence

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

## 6. Rollback

- To stop new Blob writes, set `ARTICLE_RAW_BLOB_WRITE_ENABLED=false`. Reads may
  stay on while inline raw_text still exists (dual-copy rows read inline first).
- M6B externalization preserves inline raw_text, so it is reversible by disabling
  the write flag; do not re-point or delete externalization metadata.
- **Inline clear is not reversible in this milestone.** Once inline raw_text is
  cleared, the only copy is the private Blob object plus the append-only ledger row.
  Restoring inline storage requires a **separately designed restore path** that is
  intentionally not implemented. Do not implement or improvise restore mutation as
  part of this runbook; the M6C guard blocks direct re-population.
- Never delete Blob objects. M6C and the readiness CLI never delete Blob objects
  (`blobObjectsDeleted: 0`).

## 7. Verification

```text
pnpm typecheck
pnpm lint
pnpm check
pnpm test:article-raw-readiness
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
