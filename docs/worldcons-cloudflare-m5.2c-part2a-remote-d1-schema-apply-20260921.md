# WorldCons Cloudflare M5.2c PART 2a - Remote D1 Schema Apply Operator

Date: 2026-09-21

Baseline: clean HEAD `45eb445` (chore: bind provisioned worldcons d1 databases). No Orca, no deploy,
no DNS change, no Supabase/production mutation, no authority switch. No remote schema/data import is
performed by default: the operator is dry-run unless `--apply` is given. The existing
`supabase/migrations/*.sql` files are read-only inputs and were not modified.

## 1. Objective and scope

M5 is "create four D1 databases, implement PostgreSQL export -> canonical transform -> D1 import".
M5.1 built the four D1 schemas; M5.2a/M5.2b built the local converter and import; M5.2c PART 1
created the four remote `worldcons_*` databases. PART 2a delivers the operator that applies the
M5.1 DDL to those existing databases:

- the operator-only `D1RemoteSchemaManifest` contract for the four `worldcons_*` databases;
- a fail-closed parser for the current `wrangler d1 execute --json` output;
- a deterministic expected-object set (tables + indexes) derived from the M5.1 schema;
- a dry-run-by-default plan that reads `d1 list`, `d1 info` and `sqlite_master` without writing;
- an explicit `--apply` that materializes the DDL to a file, runs
  `wrangler d1 execute NAME --remote --yes --file <path>`, and then verifies every expected table
  and index through `sqlite_master`;
- a read-only `pnpm d1:apply-schema` operator CLI and a deterministic local manifest.

Out of scope for PART 2a (deferred to PART 2b / M6): the bounded Postgres -> D1 *data* copy, D1
shadow reads, and any read/write authority switch. PART 2a applies schema only.
## 2. Method (operator-only, dry-run by default)

- `lib/cloudflare/d1/remote/schema-apply.ts` is the pure seam. It imports no Node builtins, so it
  stays in the runtime barrel; only the operator CLI imports the `node:child_process` runner.
- Preflight runs `d1 list --json` and reuses PART 1's exact classifier. A name that is absent is
  `missing` and refused, a name that appears more than once is `ambiguous` and refused, and PART 2a
  never creates a database. Any preflight error aborts before a single write.
- For each existing target it runs `d1 info NAME --json` (read-only) and records `num_tables` and the
  database UUID, cross-checking the UUID against `d1 list`.
- Apply mode calls `materializeDdl(database, sql)` with the SQL from `emitDatabaseDdl`, so the applied
  schema is always the live M5.1 schema code rather than a stale committed `.sql` file. It then runs
  `wrangler d1 execute NAME --remote --yes --json --file <path>` and parses the `--json` result
  envelope, so a non-`success` response fails closed.
- Verification runs `wrangler d1 execute NAME --remote --yes --json --command <select sqlite_master>`
  and confirms every expected table and index name is present. The check is a subset test, so the
  FTS5 shadow tables (`search_fts_data`, ...) and any D1 internal tables are ignored.
- Dry-run performs reads only (list/info/select) and writes nothing: the expected-object set that is
  not yet present is reported as `action:"apply"`, not as an error, so a plan against an un-applied
  database still reports `ok:true`.
- A failed apply aborts the remaining applies (safety over throughput); the seam returns a manifest
  with `ok:false` and per-target errors rather than throwing, so the operator still gets a
  machine-readable record. It throws only for a caller error (apply without `materializeDdl`).
- Missing objects are fatal only in apply mode; a verification read failure is always fatal.
## 3. Contract

| Type | Meaning |
| --- | --- |
| `D1SchemaObjects` | the expected table names, index names and their union for one database. |
| `BuildD1SchemaApplyManifestOptions` | the seam inputs: `runner`, `apply`, `databases`, `schema`, `materializeDdl`. |
| `D1RemoteSchemaManifestTarget` | per-target state/action, database id, `reportedTables`, expected/found/missing object counts, `verified`, errors. |
| `D1RemoteSchemaManifestTotals` | `targets` / `applied` / `present` / `missing` / `refused`. |
| `D1RemoteSchemaManifest` | `stage:"d1-remote-schema-apply"`, `dryRun`, `applied`, targets, totals, `commands`, `ok`, errors. |

`D1_SCHEMA_OBJECT_QUERY` is the single read-only verification statement. The commands recorded in the
manifest are `d1 list --json`, `d1 info NAME --json` and
`d1 execute NAME --remote --yes --json --command <select>` (plus `--file <path>` in apply mode).

## 4. Coverage

| Database | Tables | Indexes | Expected objects | Notes |
| --- | ---: | ---: | ---: | --- |
| `worldcons_core` | 30 | 48 | 78 | includes `articles`, `article_content_versions_p3`; `search_vector`/`embedding` stay relocated |
| `worldcons_ingest` | 26 | 17 | 43 | no relocated columns |
| `worldcons_ops` | 19 | 13 | 32 | no relocated columns |
| `worldcons_search` | 2 | 0 | 2 | `search_documents` + the `search_fts` FTS5 virtual table; the projection stays M7 |
| Total | 77 | 78 | 155 | every M5.1 D1 table |

Verification compares only the expected names, so the `search_fts` FTS5 shadow tables do not need to
be enumerated and D1 internals are ignored.
## 5. Verification

| Check | Result |
| --- | --- |
| `pnpm test:d1-apply-schema` | Pass, 12/12 |
| `pnpm test:d1-schema` | Pass, 19/19 (no regression) |
| `pnpm test:d1-convert` | Pass, 10/10 (no regression) |
| `pnpm test:d1-import` | Pass, 14/14 (no regression) |
| `pnpm test:d1-provision` | Pass, 16/16 (no regression) |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass |
| `pnpm d1:apply-schema --json` (real, READ-ONLY dry-run) | Pass, `ok:true`: all four targets `existing` with the recorded UUIDs, `reportedTables:0`, `foundObjects:0`; only `d1 list --json`, `d1 info NAME --json` and a read-only `d1 execute --command select ... sqlite_master` were invoked; no file was executed and no database was written |
| Remote surface | No `--apply` executed: no DDL written to any remote database, no data imported, no database created/deleted, no Worker deploy, no DNS change, no authority switch |

The focused tests prove: (1) the four targets and their expected object counts are derived from the
M5.1 schema (77 tables); (2) dry-run reads list/info/`sqlite_master` and never writes a file or
executes DDL, and reports a not-yet-applied schema as `action:"apply"` with `ok:true`; (3) dry-run
verifies an already-present schema as `action:"none"`; (4) apply materializes four DDL files, runs
`d1 execute --remote --yes --file` per database and verifies every object; (5) a missing or ambiguous
target is refused before any write; (6) a preflight failure is reported without throwing; (7) an
execute failure aborts the remaining applies; (8) verification detects a missing object; (9) apply
without `materializeDdl` throws; and (10) a static guard keeps the seam Node-free/barrelled and the
CLI behind `--apply`.

### 5.1 Expected next run (operator)

The remote databases are still empty (`reportedTables:0`). To apply the schema, the operator runs:

```bash
pnpm d1:apply-schema --apply --report --json
```

which writes the DDL to `artifacts/cloudflare-m5/d1-schema-apply/<database>.sql`, applies it remotely
and writes the manifest to `artifacts/cloudflare-m5/d1-remote-schema-apply.json`. A follow-up
`pnpm d1:apply-schema --report --json` then reports every target `verified:true`, `action:"none"`.

The bounded Postgres -> D1 *data* copy remains M5.2c PART 2b, and shadow reads remain M6.
## 6. Files

Added:

- `lib/cloudflare/d1/remote/schema-apply.ts` - the pure schema-apply seam and expected-object derivation.
- `scripts/d1-apply-schema.ts` - `pnpm d1:apply-schema` operator CLI (`--apply`, `--database`, `--ddl-dir`, `--timeout-ms`, `--json`, `--report`).
- `tests/d1-apply-schema.test.ts` - 12 focused tests.
- this document.

Changed:

- `lib/cloudflare/d1/remote/types.ts` - the schema-apply manifest/type contract.
- `lib/cloudflare/d1/remote/classify.ts` - the fail-closed `d1 execute --json` parser.
- `lib/cloudflare/d1/remote/index.ts` - export the schema-apply seam and the parser.
- `package.json` - `d1:apply-schema`, `test:d1-apply-schema`; the test added to `verify:release`.
- `docs/worldcons-cloudflare-full-migration-plan-20260920.md` - the M5 progress note and migration checklist record M5.2c PART 2a.

## 7. Rollback

Repository-only: delete `lib/cloudflare/d1/remote/schema-apply.ts`, `scripts/d1-apply-schema.ts`,
`tests/d1-apply-schema.test.ts`, this document, and revert the additive changes to
`lib/cloudflare/d1/remote/{types,classify,index}.ts` and `package.json`. Because the default mode is a
dry-run and a remote write requires `--apply`, a reverted checkout cannot by itself have applied the
schema; if `--apply` was actually run, the operator drops the applied objects (or the databases) from
the remote D1 databases manually. No data was copied, so no data rollback is required.

## 8. Next (M5.2c PART 2b)

The bounded, verified Postgres -> Cloudflare D1 *data* copy against these four schema-applied
databases: stream the M5.2a canonical datasets through the M5.2b import emitter and verify the
per-table/per-database hashes. Then M6 shadow reads compare the D1 read path against Postgres.
