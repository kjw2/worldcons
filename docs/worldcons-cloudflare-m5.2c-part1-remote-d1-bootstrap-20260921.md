# WorldCons Cloudflare M5.2c PART 1 - Remote D1 Bootstrap

Date: 2026-09-21

Baseline: clean HEAD `e6ba34d` (feat: add cloudflare m5.2b d1 import pipeline). No Orca, no deploy,
no remote schema/data import, no DNS change, no Supabase/production mutation, no authority switch.
The existing `supabase/migrations/*.sql` files are read-only inputs and were not modified.

Post-provision reconciliation (2026-09-21): the operator-only bootstrap was then executed as
`pnpm d1:provision --apply --report --json`. It created all four remote `worldcons_*` databases in
`apac` and verified each create via `d1 info`. No DDL/schema or data has been applied to any of the
four databases, and still no Worker deploy, no DNS change, and no Supabase authority switch occurred.
See section 5.1 for the recorded UUIDs and the post-apply dry-run.

## 1. Objective and scope

M5 is "create four D1 databases, implement PostgreSQL export -> canonical transform -> D1 import".
M5.1 built the four D1 schemas; M5.2a/M5.2b built the local converter and import. M5.2c is remote D1
creation plus the actual data copy. PART 1 delivers the first half only, as the narrowest possible
remote surface:

- the operator-only `D1RemoteTarget` / manifest contract for the four `worldcons_*` databases;
- a fail-closed parser for the current `wrangler d1 list --json` / `d1 info NAME --json` output;
- an exact, refusal-first classifier (`missing` / `existing` / `ambiguous`);
- a dry-run-by-default bootstrap that creates databases only with an explicit `--apply`, then
  re-lists and runs `d1 info` to prove each create before recording it;
- a read-only `pnpm d1:provision` operator CLI and a deterministic local manifest.

Out of scope for M5.2c PART 1 (deferred to PART 2 / M6): the bounded Postgres -> D1 data copy, the
remote schema/data import, D1 shadow reads, and any read/write authority switch. PART 1 also executed
the authorized `--apply` run that created the four remote databases; creating an empty database is not
a schema or data import, so every deferred item above remains untouched.

## 2. Method (operator-only, dry-run by default)

- `lib/cloudflare/d1/remote/types.ts` defines the contract: `WranglerD1Runner`, the manifest
  target/totals types, the state/action enums, the four bindings, and the `apac` default location.
  The manifest carries no wall-clock timestamp, so identical remote state serializes identically.
- `lib/cloudflare/d1/remote/targets.ts` fixes the create order to `worldcons_core` ->
  `worldcons_search` and returns copies, so selection cannot mutate the canonical targets.
- `lib/cloudflare/d1/remote/classify.ts` parses Wrangler JSON and fails closed on anything that is
  not a JSON array/object with a non-empty string `name`/`uuid`. A name that matches more than once
  is `ambiguous` and refused rather than guessed.
- `lib/cloudflare/d1/remote/bootstrap.ts` preflights with `d1 list --json`; with `apply` it creates
  the missing databases one at a time, aborts the remaining creates after the first failure, then
  re-lists and runs `d1 info NAME --json` to prove each create. It returns a manifest with `ok:false`
  and per-target errors instead of throwing, so the operator still gets a machine-readable record.
- `lib/cloudflare/d1/remote/runner.ts` is the Wrangler child-process adapter. It is deliberately not
  re-exported from the barrel (it imports `node:child_process`), rejects with a bounded message that
  never includes raw Wrangler output, and kills the child on timeout. On Windows the local `.cmd` shim
  is launched through the command interpreter (`<ComSpec> /d /c wrangler.cmd ...`) rather than spawned
  directly, which Node >= 18.20/20.12/22 rejects with `EINVAL`; on other platforms the binary is
  spawned directly.
- `scripts/d1-provision.ts` is the operator CLI. It is dry-run by default and only passes `apply`
  when `--apply` is present; it never deletes, imports schema/data, deploys, or changes authority.

## 3. Contract

| Type | Meaning |
| --- | --- |
| `WranglerD1Runner` | the invocation boundary: args -> stdout; a non-zero exit rejects. |
| `D1RemoteTarget` | one database name plus its D1 binding. |
| `D1RemoteTargetState` | `missing` / `existing` / `ambiguous` / `created` / `unknown`. |
| `D1RemoteTargetAction` | `none` / `create` / `refused`. |
| `D1RemoteManifestTarget` | per-target state, action, database id, `verified`, errors. |
| `D1RemoteManifest` | `stage:"d1-remote-bootstrap"`, `dryRun`, `applied`, targets, totals, commands, `ok`. |

## 4. Safety

- dry-run by default; creation requires the explicit `--apply` flag;
- no `d1 delete`, `d1 execute`, `d1 import`, `d1 export`, `r2 bucket`, or Worker deploy path exists;
- an ambiguous name is refused; a failed create aborts the remaining creates;
- a create is recorded only once `d1 info` confirms the same name and uuid;
- the runtime barrel imports no Node builtins, so Workers code never loads the child-process adapter.

## 5. Verification

| Check | Result |
| --- | --- |
| `pnpm test:d1-provision` | Pass, 16/16 |
| `pnpm test:d1-schema` | Pass, 19/19 (no regression) |
| `pnpm test:d1-convert` | Pass, 10/10 (no regression) |
| `pnpm test:d1-import` | Pass, 14/14 (no regression) |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm lint` | Pass |
| `pnpm check` | Pass |
| `pnpm build` (Next/Vercel path) | Pass |
| `pnpm check:vinext` | Pass, 100% compatible |
| `pnpm build:vinext` | Pass |
| `pnpm d1:provision --json` (real, READ-ONLY dry-run, pre-provision) | Pass, `ok:true`: all four targets `worldcons_core`/`worldcons_ingest`/`worldcons_ops`/`worldcons_search` reported `missing`/`create`; only `d1 list --json` was invoked; no database was created and no mutation, deploy, DNS change, or authority switch occurred |
| `pnpm d1:provision --apply --report --json` (real, authorized provision) | Pass, `ok:true`: all four targets created in `apac` and `verified:true` via `d1 info`; manifest written to `artifacts/cloudflare-m5/d1-remote-manifest.json`; no schema/DDL, data import, deploy, DNS change, or authority switch |
| `pnpm d1:provision --report --json` (real, post-provision READ-ONLY dry-run) | Pass, `ok:true`: 4 existing / 0 missing / 0 refused, every target `existing`/`none`; only the read-only list/info path was invoked |

The Windows runner fix was in place for this host verification: the local `wrangler.cmd` shim is now
launched through the command interpreter (`<ComSpec> /d /c`, falling back to `cmd.exe`) instead of
being spawned directly, which Node >= 18.20/20.12/22 rejects with `EINVAL`. That fix is what let the
real Wrangler invocation run to completion. `pnpm d1:provision --json` was then executed against the
authenticated Cloudflare account as a READ-ONLY dry-run and returned `ok:true` with all four targets
in `missing`/`create` state; it performed only `d1 list --json`, created no database, and made no
mutation, deploy, DNS change, or authority switch.

### 5.1 Remote provisioning outcome

`pnpm d1:provision --apply --report --json` was then run against the authenticated Cloudflare account.
It preflighted with `d1 list --json`, created the four missing databases in `apac`, re-listed, and ran
`d1 info NAME --json` for each, so every target recorded `state:"created"`, `action:"create"`,
`verified:true`, and `ok:true`. The four remote database UUIDs are:

| Binding | Database | UUID |
| --- | --- | --- |
| `WORLDCONS_CORE` | `worldcons_core` | `0f4c41f0-778f-4ef4-860e-b0dad05f0984` |
| `WORLDCONS_INGEST` | `worldcons_ingest` | `0ccd27ff-fd16-4071-bc94-616690708c4e` |
| `WORLDCONS_OPS` | `worldcons_ops` | `6ecdf64b-d95a-49b2-8fc4-bdd50581a3e4` |
| `WORLDCONS_SEARCH` | `worldcons_search` | `1d74ebba-918b-4f8c-9c5c-9013479df809` |

These same binding/name/id pairs are now recorded in `wrangler.jsonc` under `d1_databases`, alongside
the preserved Worker and R2 configuration.

A subsequent `pnpm d1:provision --report --json` dry-run observed the resulting state: 4 existing,
0 missing, 0 created, 0 refused, with every target `existing`/`action:"none"` and `verified:true`, so
the bootstrap is idempotent and a re-run creates nothing.

Explicitly, and still true after the provisioning run: **no schema or DDL has been applied to any of
the four databases and no data has been imported** (they are empty; creating a database does not apply
the M5.1 D1 schema). No Worker was deployed, no DNS was changed, and no Supabase/production authority
was switched — Supabase remains the production authority and the M5.2c PART 2 schema/data copy is
still outstanding.

The focused tests prove: (1) the four targets and bindings are canonical and selection cannot mutate
them; (2) the list/info parsers accept valid JSON and fail closed on malformed JSON, non-arrays,
non-objects and missing/empty `name`/`uuid`; (3) classification is exact and an ambiguous name is
refused; (4) dry-run lists and never creates; (5) apply creates only the missing databases and
verifies each create via `d1 info`; (6) an existing database is never recreated; (7) an ambiguous
preflight creates nothing; (8) a create failure aborts the remaining creates and fails the run;
(9) an unverifiable create fails the run; (10) a preflight failure is reported without throwing;
(11) an invalid location fails fast; (12) the Windows `.cmd` shim routes through the interpreter
resolved from `ComSpec` with the caller args copied, not aliased; and (13) a static guard keeps the
child-process adapter out of the runtime barrel and the CLI behind `--apply`.

## 6. Files

Added:

- `lib/cloudflare/d1/remote/types.ts` - remote bootstrap contract and manifest types.
- `lib/cloudflare/d1/remote/targets.ts` - canonical targets, bindings and selection.
- `lib/cloudflare/d1/remote/classify.ts` - fail-closed Wrangler JSON parsing and classification.
- `lib/cloudflare/d1/remote/bootstrap.ts` - dry-run/apply remote bootstrap and manifest builder.
- `lib/cloudflare/d1/remote/runner.ts` - operator-only Wrangler child-process adapter with Windows `.cmd`-through-`ComSpec` routing (not barrelled).
- `lib/cloudflare/d1/remote/index.ts` - remote bootstrap barrel.
- `scripts/d1-provision.ts` - `pnpm d1:provision` operator CLI (`--apply`, `--location`, `--database`, `--json`, `--report`).
- `tests/d1-provision.test.ts` - 16 focused tests.
- this document.

Changed:

- `package.json` - `d1:provision`, `test:d1-provision`; `test:d1-provision` added to `verify:release`.
- `wrangler.jsonc` - added the `d1_databases` array with the four canonical binding/name/id pairs, preserving the existing Worker and R2 configuration (post-provision reconciliation).
- `docs/worldcons-cloudflare-full-migration-plan-20260920.md` - the M5 progress note and migration checklist record M5.2c PART 1 and that remote D1 creation is complete.

## 7. Rollback

Repository-only: delete `lib/cloudflare/d1/remote/`, `scripts/d1-provision.ts`,
`tests/d1-provision.test.ts`, this document, the `wrangler.jsonc` `d1_databases` array, and revert the
`package.json` additions. Because the default mode is a dry-run and creation requires `--apply`, a
reverted checkout cannot by itself have created a remote database; if `--apply` was actually run, the
operator removes the created databases manually (no automated deletion exists in this slice).

## 8. Next (M5.2c PART 2)

The bounded, verified Postgres -> Cloudflare D1 data copy against these four databases: apply the
M5.1 DDL remotely, stream the M5.2a canonical datasets through the M5.2b import emitter, and verify
the per-table/per-database hashes. Then M6 shadow reads compare the D1 read path against Postgres.

The four remote databases now exist in `apac` (section 5.1) and are the targets for PART 2, but they
currently hold no schema and no data; applying the M5.1 DDL and performing the verified copy is the
entire remaining scope.
