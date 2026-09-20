# WorldCons Cloudflare M2 R2 Operator Canary Report

Date: 2026-09-20
Status: bounded M2 operator canary passed; inline clear remains prohibited

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

