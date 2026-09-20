# WorldCons artifact Blob M5 operational readiness runbook

Scope: M5 operational readiness/observability for the private Blob artifact
migration (M1 contract, M3 dual-read, M4A externalization, M4B inline clear).

This runbook adds one read-only readiness module (`lib/backfill/artifact-readiness.ts`),
one read-only CLI (`scripts/artifact-readiness.ts`, `pnpm readiness:artifact-blob`),
and one additive read-only SQL function
(`supabase/migrations/20260919120000_artifact_blob_readiness_observability.sql`).
It does not apply migrations, deploy, externalize, clear inline data, run VACUUM,
or modify production. It introduces no M6 work.

The forward-only inline restore path
(`supabase/migrations/20260919210000_artifact_blob_inline_restore.sql`,
`lib/backfill/inline-restore.ts`, `scripts/restore-inline-artifacts.ts`,
`pnpm restore:inline-artifacts`) is the rollback for M4B. It re-populates the
redundant inline payload from the already verified Blob object through the single
permit-guarded restore transition, is dry-run by default, and never writes or
deletes a Blob object.

The pre-production corrective hardening migration
(`supabase/migrations/20260919190000_artifact_blob_contract_hardening.sql`) is a
schema-only prerequisite for this rollout. It edits no earlier migration and only
(1) drops NOT NULL on `source_normalization_artifacts.normalized_output` so the M4B
inline clear and the externalized-only steady state are representable, and (2)
restores the 4 MiB inline bound on `source_fetch_artifacts.bounded_replay_payload`
that the M1 replay check dropped, as a separate `NOT VALID` check validated
afterwards. It performs no DML, no Blob/network access, no maintenance, and changes
no grant. Apply it with the other pending artifact migrations in step 1.

## 1. Invariants

- Both Blob flags stay **default OFF**: `CASE_BACKFILL_ARTIFACT_BLOB_READ_ENABLED=false`,
  `CASE_BACKFILL_ARTIFACT_BLOB_WRITE_ENABLED=false`. `WRITE` requires `READ`.
- The readiness module and CLI are **read-only**. There is no `--execute`, no
  `--acknowledge-irreversible`, and no mutation path. The CLI never calls
  `put`/`delete` and never calls an externalize/clear RPC.
- The readiness report is **aggregate-only**. It never emits storage refs, raw
  content, hashes, tokens, signed URLs, or per-row payloads, and it reports
  `storageRefsEmitted: 0` and `perRowPayloadsEmitted: 0`.
- Blob verification is **off by default**. A bare readiness run issues zero
  `head`/`get` calls. Even when requested, verification requires the Blob read
  flag to be ready, so a bare run and a read-flag-off run never touch Blob.
- Inline clear is not reversible by any direct update. Restoring the inline copy
  is possible **only** through the dedicated `pnpm restore:inline-artifacts` path
  (dry-run by default; add `--execute --acknowledge-inline-restore` to run), and
  the guard blocks every other write. The readiness report's
  `inlineRestore: "dedicated_restore_available"` field is a truthful stable marker
  that the restore path exists: readiness remains read-only and never restores;
  restore is a separate operation performed by `pnpm restore:inline-artifacts`.
- The corrective hardening migration (step 1) is schema-only: it drops NOT NULL on
  `source_normalization_artifacts.normalized_output` and re-adds the 4 MiB
  `bounded_replay_payload` inline CHECK. It writes no row, reads/writes no Blob,
  runs no maintenance, and changes no grant. A NULL `normalized_output` stays valid
  only while `normalized_output_storage_ref` and the full externalization metadata
  are present, which the existing storage/json coherence check already enforces.
- The artifact transport is **provider-selectable but defaults to Vercel**, so existing
  behavior is unchanged. See section 7 for `ARTIFACT_BLOB_PROVIDER`,
  `ARTIFACT_BLOB_BUCKET`, the explicit not-found-only read fallback, and the Vercel
  Hobby Advanced Operations cap warning. Switching providers rewrites no
  `storageRef` value and needs no migration.

## 2. What the readiness report contains

Per kind (`fetch`, `normalization`) and combined, from bounded keyset pagination
with an optional `--source` filter:

- `totalRows`, `inlinePresentRows`, `externalizedRows`
- `dualCopyRows` (inline + Blob), `blobOnlyRows`, `inlineOnlyRows`
- `metadataInconsistentRows` (partial/contradictory externalization metadata, or
  content states that violate the replay contract)
- `contractMismatchRows` (externalized rows whose contract version is not
  `worldcons-artifact-blob-v1`)
- `ledgerCoveredRows`, `clearableRows`, `clearableLedgerCoveredRows`
- `inlineBytesEstimated` (sum of recorded sizes where safely available) and
  `inlineSizeUnavailableRows`
- `batches`, `truncated`

Optional Blob verification (`--verify-sample=N`, `N` in `0..100`, default `0`)
head/get verifies at most `N` externalized rows and reports aggregate counts
only: `sampled`, `verifiedOk`, `readErrors`, `sizeMismatches`, `hashMismatches`,
`invalidDocuments`, plus the per-kind sample counts `sampledByKind.fetch` and
`sampledByKind.normalization`. Candidates are pooled per kind (each pool bounded
by `N`) and the sample is allocated with a guaranteed first pass — one attempt per
selected clearable kind, so a small `N` can never starve a later kind — followed
by a fair round-robin across every selected kind. A sample that is genuinely
smaller than the number of clearable kinds leaves at least one kind unsampled and
keeps the gate not-ready instead of passing on a partial sample.

### Gates

- `newWriteReady` (`NEW_WRITE_READY`): read flag ready **and** write flag ready
  **and** no metadata criticals (`metadataInconsistentRows == 0` and
  `contractMismatchRows == 0`) **and** a complete scan.
- `inlineClearReady` (`INLINE_CLEAR_READY`): everything `NEW_WRITE_READY` needs,
  plus zero verification read/size/hash/document errors for the requested verified
  sample (a non-empty sample), plus **per-kind sample coverage** — every selected
  kind with `clearableRows > 0` must have `sampledByKind[kind] > 0`, plus full M4A
  ledger coverage for every row considered clearable
  (`clearableLedgerCoveredRows == clearableRows`).
  If `--verify-sample` is too small to reach every selected clearable kind, the
  gate stays **not ready** with an explicit blocking reason
  (`verification_clearable_kind_unsampled_fetch` /
  `verification_clearable_kind_unsampled_normalization`); `verificationKindCoverageReady`
  is the corresponding gate flag. A single selected kind (`--kind=...`) only
  requires its own coverage.
- `critical` is true on any metadata critical or any verification size/hash/
  invalid-document error. **Any hash mismatch makes readiness critical/not-ready.**
- Blob **read errors** do not raise `critical`; they make the verification gate
  **not ready** and block `INLINE_CLEAR_READY`.

## 3. Safe rollout order

Follow this order exactly. Do not skip a step or reorder it.

1. **Apply migrations.** Apply the pending artifact migrations (the corrective
   hardening `20260919190000_artifact_blob_contract_hardening.sql`, M1 contract, M4A
   externalization, M4B inline clear, and this M5 read-only readiness function) to
   the target database. Keep both Blob flags **OFF**.
2. **Read-only readiness.** Run the readiness CLI with verification off and both
   flags off. Confirm the report is coherent (`totalRows`, `metadataInconsistentRows`,
   `contractMismatchRows`, ledger coverage) and that zero Blob reads happened.
   ```text
   pnpm readiness:artifact-blob
   pnpm readiness:artifact-blob --source=<source-key>
   pnpm readiness:artifact-blob --kind=fetch --source=<source-key>
   ```
   If the report shows `truncated: true`, the scan did not cover every row: raise
   `--max-batches` (and/or narrow `--source`) until every selected kind is
   `truncated: false`. The gates treat an incomplete scan as not-ready.
3. **Enable READ.** Set `CASE_BACKFILL_ARTIFACT_BLOB_READ_ENABLED=true` in a
   bounded process/session only. `WRITE` stays OFF.
4. **Canary reads.** Run the readiness CLI with a small verification sample and
   confirm `readErrors`, `sizeMismatches`, `hashMismatches`, and `invalidDocuments`
   are all zero for the sampled rows. The sample must be large enough to reach
   every selected clearable kind (check `sampledByKind.fetch` and
   `sampledByKind.normalization`); if it is not, `INLINE_CLEAR_READY` stays false
   with a `verification_clearable_kind_unsampled_<kind>` reason. Raise
   `--verify-sample` (and/or narrow `--kind`) until both clearable kinds are
   covered.
   ```text
   pnpm readiness:artifact-blob --source=<source-key> --verify-sample=10
   ```
5. **Enable WRITE.** Set `CASE_BACKFILL_ARTIFACT_BLOB_WRITE_ENABLED=true`
   (requires READ on). Re-run readiness and require `NEW_WRITE_READY = true` with
   no metadata criticals before proceeding.
6. **M4A dry-run, then execute small batches.** Plan first, then externalize a
   small bounded batch while preserving inline content.
   ```text
   pnpm externalize:artifacts --kind=fetch --source=<source-key> --batch-size=25
   pnpm externalize:artifacts --kind=fetch --source=<source-key> --batch-size=25 --execute
   ```
7. **Recheck readiness.** Re-run the readiness report. Confirm `dualCopyRows`
   increased, `metadataInconsistentRows`/`contractMismatchRows` stayed zero, and
   ledger coverage is complete for clearable rows.
8. **M4B dry-run.** Plan the inline clear without mutating anything.
   ```text
   pnpm clear:inline-artifacts --kind=fetch --source=<source-key> --batch-size=25
   ```
9. **Optional tiny clear canary (only now).** Only if readiness reports
   `INLINE_CLEAR_READY = true`, run a single tiny clear canary on one small
   source/kind with an explicit acknowledgement.
   ```text
   pnpm clear:inline-artifacts --kind=fetch --source=<source-key> --batch-size=1 --execute --acknowledge-irreversible
   ```
10. **Recheck readiness after the canary.** Confirmed clear moves rows from
    `dualCopyRows` to `blobOnlyRows`; readiness must stay non-critical and
    `INLINE_CLEAR_READY` must remain true before any further clear.

### Maintenance

- **No `VACUUM FULL`** as part of this migration. Bloated inline columns are only
  reclaimed by a later, separately approved Supabase-supported maintenance
  decision.

## 4. Rollout decision gates as evidence

Use the `--require-*` flags so a failed gate fails closed with exit code `2`
instead of being read by eye. `--require-new-write-ready` and
`--require-inline-clear-ready` are read-only assertions; they change no state.

```text
# Exit 2 unless read+write flags are ready and no metadata criticals exist.
pnpm readiness:artifact-blob --require-new-write-ready

# Exit 2 unless the requested verified sample is clean, covers every selected
# clearable kind, and clearable ledger coverage is complete.
pnpm readiness:artifact-blob --source=<source-key> --verify-sample=10 --require-inline-clear-ready
```

Exit codes: `0` success, `1` unexpected error or `critical`, `2` a required gate
was not ready.

## 5. Rollback

- To stop new Blob writes, set `CASE_BACKFILL_ARTIFACT_BLOB_WRITE_ENABLED=false`.
  Reads may stay on while inline content still exists (dual-copy rows read inline
  first).
- M4A externalization preserves inline content, so it is reversible by disabling
  the write flag; do not re-point or delete externalization metadata.
- **Inline clear is reversible only through the dedicated restore path.** Once
  inline content is cleared, the private Blob object plus the append-only ledger
  row are the only copies. To put the verified inline copy back, use the
  forward-only restore CLI (dry-run by default). Do not improvise a restore with
  a direct update; the guard blocks it. Restore requires the Blob read flag ready
  (`CASE_BACKFILL_ARTIFACT_BLOB_READ_ENABLED=true`); `WRITE` is never required.
  ```text
  pnpm restore:inline-artifacts --kind=fetch --source=<source-key> --batch-size=25
  pnpm restore:inline-artifacts --kind=fetch --source=<source-key> --batch-size=25 --execute --acknowledge-inline-restore
  ```
- Never delete Blob objects. M4B and the readiness CLI never delete Blob objects
  (`blobObjectsDeleted: 0`).
- To change the artifact transport, set `ARTIFACT_BLOB_PROVIDER` (and
  `ARTIFACT_BLOB_BUCKET` when using Supabase) and redeploy; there is no data change
  and no object migration. Setting `ARTIFACT_BLOB_PROVIDER=vercel` returns to the
  previous behavior, and `ARTIFACT_BLOB_READ_FALLBACK_ENABLED=false` disables the
  not-found-only read fallback. Never repoint or delete existing `storageRef` values.

## 6. Verification

```text
pnpm typecheck
pnpm lint
pnpm check
pnpm test:artifact-blob
pnpm test:artifact-blob-restore
pnpm test:artifact-blob-hardening
pnpm test:artifact-blob-provider
```

The fakes-only hardening suite
(`tests/backfill-artifact-blob-hardening.test.ts`) statically proves that the
corrective migration is additive and transactional, that `DROP NOT NULL` on
`normalized_output` exists only in it (the Gate 1 `NOT NULL` declaration is left
intact and the M4B clear still relies on the nullable column), that the 4 MiB
`bounded_replay_payload` inline bound is restored as a separate `NOT VALID` check
that still allows NULL and that the M1 replay check omitted it, and that the
migration performs no DML, grants, network, or maintenance and drops no unrelated
check.

The fakes-only readiness suite (`tests/backfill-artifact-blob-readiness.test.ts`)
proves: aggregate classification; default no Blob reads (verification off); no
refs/hashes/raw content/tokens/per-row payloads in the report; hash mismatch ⇒
critical/not-ready; size and invalid-document mismatches ⇒ critical; Blob read
error ⇒ verification gate not-ready (not critical); flags/defaults; and the
`NEW_WRITE_READY` / `INLINE_CLEAR_READY` decision gates (including full ledger
coverage, a clean verified sample, fair per-kind sample allocation — a large kind
pool cannot starve another clearable kind — fail-closed coverage when the sample
is genuinely too small, and single-kind runs).

The fakes-only restore suite (`tests/backfill-artifact-blob-restore.test.ts`)
proves: metadata planning before any Blob read; dry-run with no store; execute
gating on the read flag and a store; head/get size and SHA-256 verification,
canonical-document validation, and the object requirement before the restore RPC;
idempotent reruns; fail-closed Blob and metadata mismatches; bounded keyset
pagination; and that the new migration is additive, extends the guard with the
inline-null -> present restore transition, verifies the document byte length and
SHA-256 in the RPC, and stays service_role-only with no table UPDATE/DELETE grant.

The fakes-only provider suites (`tests/artifact-blob-provider-fallback.test.ts` and
`tests/artifact-blob-r2-transport.test.ts`) prove: Vercel remains the default,
Supabase remains a compatibility provider, and R2 is an explicit provider; Node S3
and Worker `R2Bucket` transports preserve content type/size and the content-addressed
`storageRef`; only unambiguous object-level not-found signals may enter a fallback;
bucket/auth/signature/network/rate/5xx failures fail closed; ordered fallbacks stop at
the first hit; and writes always go to the primary only.

## 7. Artifact Blob provider selection (Vercel / R2 / Supabase compatibility)

The artifact transport is provider-selectable and defaults to the current Vercel
private Blob store, so an existing deployment is unchanged until an operator opts in.
Provider selection never changes the `ArtifactBlobStore` contract, the
content-addressed `storageRef` contract
(`artifacts/{fetch|normalization}/{source}/{sha256}.json`), or any existing row, and
it needs no migration.

- `ARTIFACT_BLOB_PROVIDER` — `vercel` (default), `r2`, or compatibility
  `supabase`. M1 uses `r2` for new externalization after canary approval.
- `ARTIFACT_BLOB_BUCKET` — private provider bucket, default
  `worldcons-artifacts`. It must already exist. M1 never auto-creates a bucket.
- Node/CLI R2 access uses `R2_ENDPOINT` or `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and optional `R2_REGION=auto`.
  Workers may inject a private `R2Bucket` binding instead of S3 credentials.
- `ARTIFACT_BLOB_READ_FALLBACK_PROVIDERS` — optional ordered CSV, for example
  `vercel` while old refs are still Vercel-only. The primary may not be repeated
  and unknown/duplicate entries fail closed.
- `ARTIFACT_BLOB_READ_FALLBACK_ENABLED` — default `false`. When the primary provider
  is not Vercel and no explicit list is supplied, legacy `true` means Vercel
  fallback. It remains for compatibility.

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
M1 therefore moves new externalization writes to R2 with
`ARTIFACT_BLOB_PROVIDER=r2` only after a bounded canary. Treat the exhausted
Vercel store as a legacy fallback, and remember that a suspended store is an
operational failure, not not-found. Never repoint existing `storageRef` values.

### M1 R2 first canary (no inline clear)

The first production R2 canary is deliberately non-destructive:

1. Create/configure the private R2 bucket outside this code change and inject
   credentials or a Worker binding without printing values.
2. Set `ARTIFACT_BLOB_PROVIDER=r2` and keep the existing artifact read/write flags
   enabled only for the bounded operator process.
3. Dry-run one tiny source/kind batch, then execute at most 1–5 externalizations.
   The externalizer preserves inline payloads.
4. Run readiness with `--verify-sample` covering those candidates. Require successful
   R2 GET, exact byte size, SHA-256, and valid document checks.
5. Run the restore command/tests in dry-run/rehearsal mode to prove the restore path
   is deployable. Because inline content is intentionally still present, **do not**
   execute an inline restore or clear in this first canary.
6. Stop on any auth, bucket, signature, network, 429, or 5xx error. Such failures
   must never fall through to legacy storage.

No `clear:inline-artifacts` command is permitted in this first M1 canary.
