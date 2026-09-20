# WorldCons Cloudflare M2 R2 Operator Canary Report

Date: 2026-09-20
Status: France fetch R2 dual-copy rollout complete; inline clear remains prohibited

## Scope

M2 introduces an operator-only R2 write path for bounded migration/backfill work
while the application runtime remains on its existing deployment and write flags.
The operator path uses the locally authenticated Wrangler OAuth session and never
stores Cloudflare OAuth tokens, R2 credentials, signed URLs, or provider URLs in
database storage refs.

## Windows Wrangler resolution

Under `pnpm exec tsx`, a bare `wrangler` resolved to an unusable local shim.
The operator bridge now resolves the global Windows Wrangler shim explicitly
(`%APPDATA%\npm\wrangler.cmd`) or accepts an explicit
`WORLDCONS_WRANGLER_BIN` override. This removes PATH ambiguity while preserving
stable, redacted transport errors.

## France fetch canary

Source: `fr-conseil-constitutionnel`

M1 had already produced one R2 dual-copy row. M2 then externalized five additional
fetch artifacts through the committed operator bridge:

- first execute: 1 scanned, 1 externalized, 0 failed
- bounded expansion: 4 scanned, 4 externalized, 0 failed
- all writes preserved the inline payload
- every object was PUT, read back for size/SHA verification, and only then attached
  through the existing permit/ledger repository path

Post-canary full France fetch state:

- total rows: 1,417
- externalized rows: 1,291
- R2 dual-copy rows: 6
- existing Blob-only rows: 1,285
- inline-only rows: 126
- metadata-inconsistent rows: 0
- contract-mismatch rows: 0
- ledger-covered rows: 1,291
- clearable rows: 6
- clearable ledger-covered rows: 6
- scan truncated: false

## Readiness sampling correction

The first bounded verification attempt reported five read errors even though direct
R2 reads succeeded. The cause was a readiness sampling defect: the verification pool
accepted every externalized row, so it selected older Blob-only rows whose legacy
Vercel store is currently suspended.

The readiness gate is specifically an inline-clear verification gate. Sampling now
selects only `classification.clearable` dual-copy rows, matching the existing
comments, fairness logic, and `INLINE_CLEAR_READY` purpose. A regression test proves
that earlier Blob-only rows cannot consume the verification budget ahead of a
clearable dual-copy row.

After the correction, a five-object R2 verification sample returned:

- sampled: 5
- verified OK: 5
- read errors: 0
- size mismatches: 0
- hash mismatches: 0
- invalid documents: 0
- verification ready: true
- ledger coverage ready: true
- new-write ready: true
- inline-clear ready: true
- blocking reasons: none

## Safety decision

`INLINE_CLEAR_READY=true` is evidence that the tested copies are recoverable; it is
not authorization to delete inline content. No inline clear was executed. The M2
rollout continues by creating verified R2 dual copies in bounded batches.

No Vercel Blob object was deleted, no R2 corpus object was deleted, and no corpus row
was deleted.

## France fetch completion

The bounded rollout was continued until no inline-only France fetch candidate
remained. Every successful externalization preserved the inline payload and used the
same production externalization flow: upload to R2, read back, verify size/SHA-256,
then attach metadata through the existing permit/ledger path.

Final full-scan state:

- total rows: 1,417
- externalized rows: 1,417
- existing legacy Blob-only rows: 1,285
- R2 dual-copy rows: 132
- inline-only rows: 0
- metadata-inconsistent rows: 0
- contract-mismatch rows: 0
- ledger-covered rows: 1,417
- clearable rows: 132
- clearable ledger-covered rows: 132
- scan truncated: false

Final bounded verification returned:

- sampled: 10
- verified OK: 10
- read errors: 0
- size mismatches: 0
- hash mismatches: 0
- invalid documents: 0
- new-write ready: true
- inline-clear ready: true
- blocking reasons: none

A final externalization dry run scanned zero candidates, confirming the France fetch
inline-only queue is empty.

### Operator batch-size finding

On this Windows/DevSpace host, a 10-row Wrangler-backed batch can approach or exceed
the command wall-time boundary because each row performs multiple remote R2
operations. A timed-out invocation continued after the caller stopped waiting, which
made the nominal 10-row operator window unsuitable as a hard operational bound.

The safe operating rule for the remainder of M2 is therefore:

- Wrangler operator externalization batch size: at most 5 rows per invocation;
- never start a replacement invocation merely because the caller timed out;
- inspect the live process and ledger first;
- after bounded waves, run full aggregate readiness and a clean verification sample;
- inline clear remains a separate, explicitly authorized operation and was not run.

The temporary `_canary/` R2 objects created during transport debugging were removed
after the corpus rollout passed. No database-referenced R2 object was deleted.

## France normalization completion

The France normalization rollout is complete.

- total rows: 1,417
- externalized rows: 1,417
- existing legacy Blob-only rows: 44
- R2 dual-copy rows: 1,373
- inline-only rows: 0
- metadata-inconsistent rows: 0
- contract-mismatch rows: 0
- ledger-covered rows: 1,417
- clearable rows: 1,373
- clearable ledger-covered rows: 1,373
- scan truncated: false

The final verification sample returned 20/20 verified, with zero read, size, hash,
or document errors. A final externalization dry run returned zero candidates.

The Wrangler operator transport was optimized without weakening verification: the
real remote GET used for the head/size check is reused only for the immediately
following SHA/document verification of the same object. Bounded execution
concurrency remains explicit and defaults to one.

The stable high-throughput operating point on the current host is 40 rows with
concurrency 8 under a single supervisor process.

## Duplicate-run protection

The operator CLIs now acquire a source/kind or source/table cross-process lock before
an execute run. A live concurrent claimant fails closed with operator_lock.busy.
Stale lock directories are reclaimed only when the recorded PID is no longer alive.

## Article raw R2 canary

The first article raw R2 canary targeted articles / fr-conseil-constitutionnel.

- dry-run candidates inspected: 20
- already exact-idempotent legacy rows: 16
- newly externalized to R2: 4
- failed: 0
- inline raw_text preserved: yes

The four rows created by the canary actor were separately re-read from R2 and
verified against the append-only article raw externalization ledger and the still
inline database value: 4/4 verified, with zero read, size, SHA-256, decode, or text
mismatch errors.

Aggregate article raw readiness still reports read errors for older dual-copy rows
whose object lives only in the suspended legacy store. This warning is preserved:
INLINE_CLEAR_READY remains closed for the mixed legacy/R2 set. New R2
externalization may continue, but no inline clear is authorized until legacy-object
recovery/provider reconciliation is complete.

### France articles completion

The France articles carrier is now fully externalized while retaining inline
raw_text:

- total rows: 382
- externalized rows: 382
- dual-copy rows: 382
- inline-only rows: 0
- metadata-inconsistent rows: 0
- ledger-covered rows: 382
- ledger gaps/conflicts: 0

The supervised R2 rollout attached 360 new rows. Two additional rows failed closed
during remote R2 head verification with artifact_blob.r2_wrangler_head_failed; they
were not attached, were retried after the supervisor stopped, and then externalized
successfully. The retry ended with 2 externalized, 380 exact-idempotent, and zero
failures.

The earlier four-row R2 canary remained fully verified. Legacy dual-copy rows are
still treated as a separate provider-recovery concern, so no inline clear follows
from the carrier reaching inline-only=0.

### France article content versions completion

The France article_content_versions_p3 carrier is also complete:

- total rows: 808
- externalized rows: 808
- dual-copy rows: 808
- inline-only rows: 0
- metadata-inconsistent rows: 0
- ledger-covered rows: 808
- ledger gaps/conflicts: 0

The versions canary created 5 new R2 rows and verified all 5/5 with zero read,
size, SHA-256, decode, or text mismatch errors. The supervised rollout then
externalized the remaining 788 rows with zero failed batches/markers.

France article raw is therefore complete across both carriers:

- articles: 382/382 externalized
- article_content_versions_p3: 808/808 externalized
- combined: 1,190/1,190 externalized
- combined inline-only: 0
- inline raw_text deletion: 0

INLINE_CLEAR_READY remains intentionally closed for the mixed legacy/provider
history until the legacy store recovery/reconciliation step is completed.

## Germany article raw completion

The de-bverfg article raw rollout is complete across both carriers.

Articles:

- total rows: 328
- externalized rows: 328
- dual-copy rows: 328
- inline-only rows: 0
- metadata-inconsistent rows: 0
- ledger-covered rows: 328

Article content versions:

- total rows: 827
- externalized rows: 827
- dual-copy rows: 827
- inline-only rows: 0
- metadata-inconsistent rows: 0
- ledger-covered rows: 827

Combined Germany article raw:

- total/externalized: 1,155/1,155
- inline-only: 0
- inline raw_text deletion: 0

The Germany canaries completed with zero failures. The supervised rollout then
externalized the remaining 308 article rows and 807 version rows with no failed
batch marker. Final readiness reported complete metadata and ledger coverage for
both carriers.

As with France, completion of dual copies is not authorization to clear inline
raw_text. Legacy/provider reconciliation remains a separate M2/M13 gate.

## Spain article raw completion

The es-tribunal-constitucional article raw rollout is complete across both carriers.

Articles:

- total rows: 424
- externalized rows: 424
- dual-copy rows: 424
- inline-only rows: 0
- metadata-inconsistent rows: 0
- ledger-covered rows: 424

Article content versions:

- total rows: 1,340
- externalized rows: 1,340
- dual-copy rows: 1,340
- inline-only rows: 0
- metadata-inconsistent rows: 0
- ledger-covered rows: 1,340

Combined Spain article raw:

- total/externalized: 1,764/1,764
- inline-only: 0
- inline raw_text deletion: 0

The Spain canaries completed with zero failures. The supervised rollout then
externalized the remaining 404 article rows and 1,310 version rows with no failed
batch marker. Final readiness reported complete metadata and ledger coverage for
both carriers.

Inline clear remains intentionally unexecuted.

## United States article raw completion

The us-scotus article raw rollout is complete across both carriers.

Articles:

- total rows: 134
- externalized rows: 134
- dual-copy rows: 134
- inline-only rows: 0
- metadata-inconsistent rows: 0
- ledger-covered rows: 134

Article content versions:

- total rows: 281
- externalized rows: 281
- dual-copy rows: 281
- inline-only rows: 0
- metadata-inconsistent rows: 0
- ledger-covered rows: 281

Combined United States article raw:

- total/externalized: 415/415
- inline-only: 0
- inline raw_text deletion: 0

The versions supervisor had one fail-closed row. No metadata attach occurred for that
row. A low-concurrency retry then externalized exactly one row, reported the other
280 rows as exact-idempotent, and completed with zero failures.

## M2 corpus externalization checkpoint

The bounded operator/backfill portion of M2 is complete for the currently present
corpus.

Artifact fetch + normalization:

- total rows: 3,543
- externalized rows: 3,543
- inline-only rows: 0
- metadata-inconsistent rows: 0
- contract-mismatch rows: 0
- ledger-covered rows: 3,543
- dual-copy rows: 1,505
- legacy Blob-only rows: 2,038

Article raw:

- total rows: 4,524
- externalized rows: 4,524
- dual-copy rows: 4,524
- inline-only rows: 0
- metadata-inconsistent rows: 0
- ledger-covered rows: 4,524
- inline raw_text deletion: 0

This checkpoint does not claim that every historical object is resident in R2.
In particular, 2,038 artifact rows remain externalized only to the suspended legacy
Blob provider, and some older article-raw refs also predate the R2 authority change.
Those rows remain protected by retained inline content where available and by the
legacy-provider recovery gate. No legacy object is deleted in M2.

Application-runtime R2 write authority is intentionally deferred to the Workers
R2Bucket binding path in M3. The operator/backfill path is now ready and verified;
runtime authority is not switched on Vercel with long-lived S3 credentials.

