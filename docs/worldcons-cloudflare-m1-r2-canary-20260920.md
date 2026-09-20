# WorldCons Cloudflare M1 R2 Canary Report

Date: 2026-09-20
Status: M1 operational canary passed

## Scope

This canary validated the first real Cloudflare R2 object path for WorldCons without
clearing inline database content and without deleting any Vercel Blob object.

## R2 bucket

- Bucket: `worldcons-artifacts`
- Location hint: APAC
- Storage class: Standard
- `r2.dev` public URL: disabled
- Custom domains: none
- Public access: not enabled

## Storage canary

A small JSON object was uploaded with Wrangler OAuth to the remote R2 bucket and then
downloaded again. The downloaded object matched the local object by exact byte size
and SHA-256 and parsed as valid JSON.

## Real artifact canary

Source: `fr-conseil-constitutionnel`
Kind: `fetch`
Batch size: 1

The existing WorldCons externalization planner selected one pending inline artifact.
Its canonical JSON document was rebuilt using the production planner, then:

1. local size/hash matched the plan;
2. the exact content-addressed object was uploaded to R2;
3. the object was downloaded from R2;
4. downloaded byte size matched;
5. downloaded SHA-256 matched;
6. downloaded JSON parsed successfully;
7. only after those checks, the existing permit/ledger repository attach path was
   invoked;
8. the inline payload remained present.

Canary artifact size: 14,051 bytes.

## Post-canary readiness

Full France fetch scan:

- total rows: 1,417
- externalized rows: 1,286
- Blob-only rows: 1,285
- dual-copy rows: 1
- inline-only rows: 131
- metadata-inconsistent rows: 0
- contract-mismatch rows: 0
- ledger-covered rows: 1,286
- clearable rows: 1
- scan truncated: false

This is the exact expected transition from the pre-canary state:

- externalized: +1
- dual-copy: +1
- inline-only: -1
- ledger coverage: +1

The canary row was checked directly and still had its inline payload while the
externalization ref/hash/timestamp/contract metadata were present.

## Restore rehearsal

`restore:inline-artifacts` was run in dry-run mode for one France fetch artifact.
It planned one restore candidate with zero Blob writes, zero Blob deletes, zero
database restores, zero conflicts, and zero failures.

The dry run intentionally performs no object read and requires no storage token.

## Safety

- No inline clear was executed.
- No Vercel Blob object was deleted.
- No R2 artifact object used by the database was deleted.
- No corpus row was deleted.
- No VACUUM FULL or other destructive database maintenance was run.
- The production read/write flags remain unchanged and default-off for this
  migration path.

## M1 result

M1 R2 foundation and operational canary are complete.

The next milestone is M2: establish R2 as the new-write authority. Before runtime
cutover, Node/Vercel-side callers need bucket-scoped R2 S3 credentials (or the write
path must move into a Worker with an R2 binding). Wrangler OAuth was sufficient for
this operator canary but is not the intended production application credential.

