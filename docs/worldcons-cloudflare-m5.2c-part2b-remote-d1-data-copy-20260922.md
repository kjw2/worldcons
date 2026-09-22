# WorldCons Cloudflare M5.2c PART 2b - Remote D1 Data Copy Operator

Date: 2026-09-22

Baseline: HEAD `dcb6545` (fix: make remote d1 schema apply idempotent), with the PART 2b additions
present in the working tree. No Orca, no deploy, no DNS change, no Supabase/production mutation, no
authority switch. The operator is dry-run by default: it performs no remote write unless the
operator passes an explicit `--apply`. The existing `supabase/migrations/*.sql` files are read-only
inputs and were not modified.

Status at the time of writing: the four remote `worldcons_*` databases exist and their M5.1 schemas
are already applied and verified (M5.2c PART 2a: `worldcons_core` 78/78 objects,
`worldcons_ingest` 43/43, `worldcons_ops` 32/32, `worldcons_search` 2/2). The PART 2b data-copy
operator is **implemented and offline-verified**. Only the `worldcons_core.sources` 4-row canary has
been copied into a remote database so far (section 6); the broader production data copy remains
pending. No Worker was deployed, no DNS was changed, and Supabase remains the production authority.

## 1. Objective and scope

M5 is "create four D1 databases, implement PostgreSQL export -> canonical transform -> D1 import".
M5.1 built the four D1 schemas; M5.2a/M5.2b built the local converter and import; M5.2c PART 1
created the four remote databases; PART 2a applied the M5.1 DDL to them. PART 2b delivers the
bounded, verified Postgres -> remote D1 **data** copy:

- the operator-only `D1RemoteDataCopyManifest` contract for the three relational `worldcons_*`
  databases;
- a canonical source/remote comparison that classifies each migratable table fail-closed;
- a dry-run-by-default plan that reads the Postgres source and the remote D1 tables without writing;
- an explicit `--apply` that copies the missing suffix as deterministic PLAIN-insert chunk files,
  verifies row-count progress per chunk, then verifies the full canonical hash;
- a read-only `pnpm d1:copy-data` operator CLI and a deterministic local manifest.

Out of scope (deferred to M6+): the `worldcons_search` projection rebuild, D1 shadow reads, and any
read/write authority switch. PART 2b copies data only; it never applies DDL and never creates or
deletes a database.

## 2. Method (operator-only, dry-run by default)

`lib/cloudflare/d1/remote/data-copy.ts` is the seam. It imports no Node builtins (`node:child_process`
and `pg` are injected by the operator CLI), so it stays in the runtime barrel. `scripts/d1-copy-data.ts`
is the operator CLI that supplies the Wrangler child-process runner and one of two read-only sources,
selected with `--source=` (section 2.1 / 2.2).

For each selected database and table the seam:

1. reads the M5.2a canonical source dataset through the injected `PostgresRowSource`
   (`convertTable` + the M5.2a transform) and records its row count and canonical hash;
2. reads the remote D1 table back through the **authored projection** (`d1ReadStatement`: authored
   D1 columns only, primary-key order, bounded `LIMIT`/`OFFSET`) via
   `wrangler d1 execute NAME --remote --yes --json --command <select>`;
3. revives the stored rows (JSON/array columns are canonical JSON text and are parsed back) and
   re-canonicalizes them with the same M5.2a transform, so the remote hash is directly comparable to
   the source hash;
4. classifies the table (section 2.4) and, only in apply mode for a `pending`/`resumable` table,
   copies the missing suffix (section 2.5).

### 2.1 Source authority: explicit URL only, never DATABASE_URL (`--source=postgres`, default)

The source kind is selected with `--source=postgres|supabase-linked`; `postgres` is the default and
keeps the exact behavior below. In `postgres` mode the `pg` source is supplied **only** through
`--url=` or the `WORLDCONS_D1_SOURCE_URL` environment variable. The CLI refuses to run when neither
is set:

```
postgres export requires --url= or WORLDCONS_D1_SOURCE_URL; refusing to guess a production read
```

There is deliberately **no fallback to `DATABASE_URL`** or any other environment variable, so a
production read can never be guessed from ambient configuration. The focused tests assert the CLI
does not reference `DATABASE_URL` in executable code (the safety comments may name it; the
comment-stripped code must not), and that the postgres branch is the only one that resolves a URL.

### 2.2 Linked Supabase fallback for the Windows/IPv6 direct-endpoint issue (`--source=supabase-linked`)

`lib/cloudflare/d1/convert/supabase-linked-source.ts` is a second, operator-only `PostgresRowSource`
backed by the Supabase CLI (`supabase db query --linked -o json <sql>`) instead of a direct `pg`
connection. It exists to work around a real operator-machine problem: on Windows the direct Postgres
endpoint is only reachable over IPv4, but a Supabase pooled/direct host that returns an **IPv6-only**
`AAAA` record cannot be dialed by the `pg` client on that host, so `--source=postgres` cannot connect
at all. The linked CLI resolves its own project connection (including any IPv4/`supavisor` routing the
CLI uses), which sidesteps the direct-endpoint IPv6 problem without an operator-side connection string.

Properties of the linked mode:

- `--source=supabase-linked` constructs `createSupabaseLinkedRowSource()` and **inspects no URL
  environment variable** — not `--url`, `WORLDCONS_D1_SOURCE_URL`, nor `DATABASE_URL`. The linked CLI
  resolves its own target project, so there is nothing to guess and no ambient URL to leak.
- The module imports `node:child_process` and is therefore **never re-exported from the convert
  barrel**; only the operator CLI imports it directly, so runtime Workers code never loads it.
- The SELECT is authored from the hand-authored schema (guarded, double-quoted identifiers;
  `LIMIT`/`OFFSET` inlined only after a safe-integer check), passed as a single `argv` entry to
  `spawn` with `shell:false` (routed through `cmd.exe /d /c` on Windows so the shim resolves via
  `PATH`/`PATHEXT`), with a bounded timeout and bounded stdout/stderr.
- The CLI stdout is parsed fail-closed: exactly one JSON envelope with a `rows` array is required, and
  every decoded value is preserved exactly (bigint decimals stay strings, jsonb stays objects, arrays
  stay arrays, booleans stay booleans), so no scalar is coerced before the M5.2a canonical transform.
- Only the read source changes: the data-copy seam, its comparison semantics, the chunked
  plain-insert apply and the hash verification are identical in both modes, and `sourceKind` is
  recorded in the manifest for diagnostics only.

The linked source is an **alternative read path, not a data mutation**: it is read-only like the `pg`
source, and selecting it does not change the copy semantics or the scope of what has been copied so
far (see section 6). It is still dry-run by default and still requires `--apply` for any write.

### 2.3 Scope: core/ingest/ops only, search skipped

`D1_REMOTE_DATA_COPY_DATABASES` is exactly `worldcons_core`, `worldcons_ingest`, `worldcons_ops`.
`worldcons_search` is deliberately **skipped**: its tables are virtual or derived from other
databases, so it is never copied and is rebuilt by the M7 projection. Selecting `--database=worldcons_search`
yields zero copy targets, zero commands and zero writes (verified by test).

Within scope, "migratable" means a table that is not `virtual` and has a non-null `sourceTable`; the
processing order is the authored deterministic order (tables sorted by name per database, targets in
the canonical `core` -> `ingest` -> `ops` order).

### 2.4 Canonical comparison and states

| State | Meaning |
| --- | --- |
| `pending` | the remote table is empty; the whole dataset is missing |
| `existing` | remote row count AND canonical hash exactly equal the source dataset |
| `resumable` | remote rows are a strict canonical prefix of the source dataset |
| `applied` | this run copied the missing suffix and the final read matched |
| `refused` | remote rows are neither the full dataset nor a canonical prefix (never written) |
| `unknown` | a read or verification failed, so the state is unproven |

The comparison is fail-closed: an exact count + hash match is `existing` (a verified no-op with zero
writes), an empty remote table is `pending`, a strict canonical prefix (compared row-by-row under
canonical JSON) is `resumable` and only the suffix is copied, and **anything else is `refused`** with
no write attempted. A remote table that is longer than the source, or whose rows do not stand in
canonical-prefix relation to the source, is refused rather than reconciled.

### 2.5 Apply: plain inserts, deterministic chunks, verified progress, abort on first error

Apply is opt-in: `apply:true` **and** a `materializeChunk` implementation are required (the seam
throws if apply is requested without a chunk materializer). In apply mode the missing suffix is:

- emitted by the M5.2b import emitter as **PLAIN `insert` statements only** — the seam contains no
  `insert or replace`, `replace into`, `upsert`, `update ... set`, `delete from`, `drop table`, or
  `create table` (a static guard asserts this against the comment-stripped source);
- grouped greedily into deterministic chunk files bounded by statement count and byte size, written
  to `artifacts/cloudflare-m5/d1-data-copy/<database>/<table>/chunk-NNNN.sql`
  (zero-padded `chunk-0000.sql`, `chunk-0001.sql`, ...; a single oversized statement is emitted alone
  rather than dropped);
- executed serially through `wrangler d1 execute NAME --remote --yes --file <path>`. The write stdout
  is deliberately **not** parsed; the runner already rejects a non-zero exit, and the count/hash
  re-reads below are authoritative (the same lesson recorded in PART 2a section 2.1);
- **verified per chunk**: after every chunk the remote `count(*)` is re-read and must equal the exact
  expected progress (`prior expected + chunk rowCount`), otherwise the run fails;
- **verified at the end**: after the last chunk the whole table is read back, re-canonicalized, and its
  hash must equal the source dataset hash exactly, otherwise the run fails;
- **abort on first error**: the first failing table sets `aborted` and every remaining table is
  recorded as `refused` with "not attempted: data copy aborted after an earlier failure". The seam
  never throws for a remote failure — it returns a manifest with `ok:false` and per-table errors so the
  operator still gets a machine-readable record.

### 2.6 Windows default Wrangler runner: local Node entrypoint, one argv per argument

On Windows the **default** Wrangler runner in `lib/cloudflare/d1/remote/runner.ts` no longer goes
through the `wrangler.cmd` shim or `cmd.exe`: it launches Node (`process.execPath`) directly with the
absolute local `node_modules/wrangler/bin/wrangler.js` entrypoint as its first argument, followed by
every D1 argument unchanged. Passing the vector through the command interpreter re-parses it into a
command line, which splits a spaceful `--command <SQL>` into several arguments and fails; spawning
Node with the JS entrypoint keeps any SQL string containing spaces as exactly one `argv` entry. The
default path fails closed when the local entrypoint is missing, and an explicit custom
`binary`/`prefixArgs` still routes through `cmd.exe /d /c`.

## 3. Contract

| Type | Meaning |
| --- | --- |
| `WranglerD1Runner` | the invocation boundary (args -> stdout); a non-zero exit rejects. |
| `PostgresRowSource` | the read-only Postgres export boundary (the M5.2a source contract). |
| `D1RemoteDataCopyTableTarget` | per-table state/action, expected vs remote row counts and hashes, copied rows, chunk count, `verified`, errors. |
| `D1RemoteDataCopyManifestTarget` | per-database rollup: state/action, table count, row totals, `verified`, tables, errors. |
| `D1RemoteDataCopyManifestTotals` | `databases` / `tables` / `expectedRows` / `remoteRows` / `copiedRows` / `existing` / `resumable` / `pending` / `copied` / `refused`. |
| `D1RemoteDataCopyManifest` | `stage:"d1-remote-data-copy"`, `dryRun`, `applied`, targets, totals, `commands`, `ok`, errors. |

The manifest contains no wall-clock timestamp, so identical remote state produces byte-identical
JSON. `commands` records the Wrangler argument vectors executed, in order, for the audit trail.

## 4. CLI

`pnpm d1:copy-data` (dry-run by default). All examples reference the source URL through the
environment variable; a secret URL must never be pasted into a shell history, this document, or the
manifest.

```
# dry-run / compare (default, no write) - reads source + remote, reports state
pnpm d1:copy-data --report

# dry-run against one database only
pnpm d1:copy-data --database=worldcons_core

# dry-run against a subset of tables (authored deterministic order preserved)
pnpm d1:copy-data --database=worldcons_core --tables=events,venues

# machine-readable manifest to stdout
pnpm d1:copy-data --json

# apply (explicit opt-in) - copies the missing suffix, verifies counts + hash
pnpm d1:copy-data --apply --report

# apply with chunk knobs
pnpm d1:copy-data --apply --batch-size=1000 --rows-per-statement=50 --max-statements-per-chunk=100

# linked fallback (no --url and no URL env var): read via the linked Supabase CLI
pnpm d1:copy-data --source=supabase-linked --database=worldcons_core --report
```

Flags: `--source=postgres|supabase-linked` (default `postgres`), `--url=` (or
`WORLDCONS_D1_SOURCE_URL`; `postgres` mode only), `--apply`, `--database=` (repeatable/comma-separated,
validated against the canonical set), `--tables=`, `--batch-size=`, `--rows-per-statement=`,
`--max-statements-per-chunk=`, `--max-bytes-per-chunk=`, `--timeout-ms=`, `--json`, `--report`.

`--source=supabase-linked` ignores `--url` entirely and resolves no URL environment variable.

- `--report` writes the deterministic manifest to
  `artifacts/cloudflare-m5/d1-remote-data-copy.json`.
- `--json` prints the manifest to stdout.
- `--database` and `--tables` narrow the run; an unknown table selection fails **before** the runner
  is called; an empty `--tables` selects zero tables (and zero writes).
- The process exits non-zero when `manifest.ok` is false.

## 5. Safety

- dry-run by default; a remote write requires the explicit `--apply` flag;
- the Postgres read requires an explicit `--url=`/`WORLDCONS_D1_SOURCE_URL`; there is no
  `DATABASE_URL` fallback;
- `--source=supabase-linked` reads through the linked Supabase CLI and resolves no URL environment
  variable at all; it is a read-only alternative read path that changes no copy semantics;
- `worldcons_search` is out of scope and can never be copied;
- apply emits PLAIN `insert` statements only — no replace/upsert/update/delete/drop/create;
- writes are bounded by deterministic chunk files, and every chunk is count-verified before the next;
- a full canonical hash check follows the last chunk; a mismatch fails the run;
- the first error aborts the remaining tables (safety over throughput);
- no database is created or deleted, no DDL is applied, no Worker is deployed, no DNS is changed;
- the Wrangler child-process adapter is not barrelled, so runtime Workers code never loads it.

## 6. Verification

| Check | Result |
| --- | --- |
| `pnpm test:d1-schema` | Pass, 19/19 |
| `pnpm test:d1-convert` | Pass, 10/10 |
| `pnpm test:d1-import` | Pass, 14/14 |
| `pnpm test:d1-provision` | Pass, 17/17 |
| `pnpm test:d1-apply-schema` | Pass, 15/15 |
| `pnpm test:d1-copy-data` | Pass, 18/18 |
| `pnpm test:d1-supabase-linked-source` | Pass, 10/10 |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass |
| `pnpm check` | Pass |
| `git diff --check` | Pass |

The checks above are the actual completed verification for this slice. The full release suite
(`pnpm verify:release`) and any gates not listed here were **not** run as part of this record and
remain optional/pending.

A real production read-only end-to-end dry-run was also completed using
`--source=supabase-linked --database=worldcons_core --tables=sources` against the live project. It
succeeded: the canonical source dataset was 4 rows, the remote D1 `worldcons_core.sources` table was
0 rows, the table was classified `pending` with action `copy`, the manifest reported `ok:true`, and
the run performed zero writes.

The `sources` canary was then **subsequently applied and verified** in the same
`--source=supabase-linked --database=worldcons_core --tables=sources` scope. The 4 missing rows were
copied in a single chunk; the source and remote canonical hashes matched; and the manifest reported
`ok:true`. An immediate read-only re-run reported 4 source rows and 4 remote rows with state
`existing`, action `none`, `verified:true`, `copied:0`, and zero write commands — an idempotent no-op
confirming exact parity.

So far **only** the `worldcons_core.sources` 4-row canary has been copied into a remote database. The
broader production data copy — the remaining `worldcons_core` tables and the `worldcons_ingest` and
`worldcons_ops` databases — **remains pending**, and Supabase remains the production authority.

The focused tests (`tests/d1-copy-data.test.ts`) prove: (1) a dry-run over an empty remote plans a
`pending` copy with zero writes and zero chunk files; (2) an apply from an empty remote reaches exact
verified parity (`applied`, `verified`, `remoteHash == expectedHash`); (3) an already-complete remote
is a verified no-op with zero writes; (4) a strict canonical prefix resumes and copies only the
suffix (the persisted prefix is never re-inserted); (5) a non-prefix partial remote is refused before
any write; (6) a remote longer than the source is refused with zero writes; (7) a chunk file-execution
error fails the manifest and stops the copy; (8) malformed remote read JSON fails closed with zero
writes; (9) a `count(*)` that does not match expected progress fails the manifest; (10) a value
corrupted after the chunk count check fails the final canonical hash; (11) an empty source over an
empty remote is a verified `existing` no-op; (12) two identical runs materialize byte-identical chunks
(zero-based deterministic per table); (13) selecting `worldcons_search` yields zero targets and zero
commands; (14) the rich table round-trips JSON, array, bigint-text and boolean canonical families
exactly; (15) a static guard keeps destructive DML and Node operator imports out of the seam and keeps
`if (!apply)` and `--file` in place; (16) a table selection narrows the copy and never reads the
unselected table; (17) an unknown table selection fails before the runner is called; and (18) the CLI
exposes a deterministic, url-only, opt-in apply contract with the artifact layout keyed by database
and table.

> The suite recorded above (the six `pnpm test:d1-*` gates, `pnpm typecheck`, `pnpm lint`,
> `pnpm check`, and `git diff --check`) is the verification recorded for this slice. It does not claim
> that the full `pnpm verify:release` suite or any gate not listed above has passed; running the full
> release suite remains optional/pending if desired.

## 7. Safe live-run sequence

No production data copy has been executed. When the operator authorizes one, run it in this order and
review each step before continuing. Never paste the source URL into a command; export it once into the
environment.

```
# 0) export the Postgres source URL explicitly (from a secret store, not a file/history)
export WORLDCONS_D1_SOURCE_URL=<source-url>        # set in the operator shell only

# 1) first, a small dry-run against ONE small table to confirm read + comparison only
pnpm d1:copy-data --database=worldcons_core --tables=<small-table> --report --json

# 2) then a dry-run of a whole selected database to size the copy and see pending/resumable/refused
pnpm d1:copy-data --database=worldcons_core --report

# 3) only after reviewing the dry-run report, apply the reviewed scope
pnpm d1:copy-data --database=worldcons_core --apply --report

# 4) repeat the read-only dry-run: it must now report every table existing / verified, zero writes
pnpm d1:copy-data --database=worldcons_core --report
```

Expected outcomes: step 1-2 are read-only and write nothing; step 3 copies only the missing suffix
and leaves every copied table `applied`/`verified` with `remoteHash == expectedHash`; step 4 is an
idempotent read-only re-run that reports `existing`/`none`/`verified` for the applied tables. Any
`refused` or `unknown` table must be investigated before proceeding; a `refused` non-prefix table
means the remote is not a clean prefix and must be reconciled manually (section 9).

Supabase remains the production authority throughout. No deploy, no DNS switch, and no read/write
authority change is part of PART 2b or of this sequence.

## 8. Files

Added:

- `lib/cloudflare/d1/remote/data-copy.ts` - the pure remote data-copy comparison/apply seam.
- `scripts/d1-copy-data.ts` - `pnpm d1:copy-data` operator CLI (`--url`/`WORLDCONS_D1_SOURCE_URL`,
  `--apply`, `--database`, `--tables`, chunk/size knobs, `--json`, `--report`).
- `tests/d1-copy-data.test.ts` - 18 focused tests.
- this document.

Changed:

- `package.json` - `d1:copy-data`, `test:d1-copy-data`; `test:d1-copy-data` added to `verify:release`.

(The seam and CLI reuse the existing M5.2a converter/transform, M5.2b emitter, the PART 1
`runner.ts` child-process adapter and the PART 2a `classify.ts` fail-closed JSON parser; those files
are unchanged by this slice.)

## 9. Rollback and recovery

Repository-only: delete `lib/cloudflare/d1/remote/data-copy.ts`, `scripts/d1-copy-data.ts`,
`tests/d1-copy-data.test.ts`, this document, and revert the additive `package.json` entries. Because
the default mode is a dry-run and a remote write requires `--apply`, a reverted checkout cannot by
itself have copied any data.

Remote semantics, stated explicitly:

- **No destructive rollback capability.** This operator has **no** destructive rollback: it contains
  no `delete`/`drop`/`replace` path and cannot remove, truncate, or undo any row it has written. Any
  deliberate rollback or reconciliation must be a **separate, manually authorized procedure outside
  `d1:copy-data`**; the operator never performs it, automatically or otherwise.
- **Recovery is prefix-resume.** A copy that stopped after a chunk leaves a strict canonical prefix,
  which the next run detects as `resumable` and continues from — it re-reads the remote prefix, copies
  only the suffix, and re-verifies. This is why the copy is safe to re-run.
- **A refused table is a stop signal.** If the remote is neither exact nor a canonical prefix
  (for example a manually edited row, or a remote longer than the source), the run refuses and writes
  nothing; the operator reconciles the remote state before re-running.
- **Fail-closed on unproven state.** A read or verification failure is `unknown`, not a silent pass;
  the manifest records the error and the process exits non-zero.

## 10. Next

The implementation can be checkpointed after the recorded suite (section 6). After that, the live
read-only dry-run/copy follows: execute the authorized live copy using the safe sequence in section 7,
beginning with the read-only dry-run and comparison before any `--apply`. Once the data copy is
complete and verified, M6 shadow reads compare the D1 read path against Postgres before any read/write
authority is considered. Supabase remains the production authority and no deploy or DNS switch occurs
in this slice.
