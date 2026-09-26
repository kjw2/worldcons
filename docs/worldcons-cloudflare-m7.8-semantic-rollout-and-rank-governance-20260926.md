# WorldCons Cloudflare M7.8 — Semantic rollout + rank governance

Date: 2026-09-26

## Status

M7.8-A (explicit semantic-authority rollout tooling) production state is
**APPLIED / VERIFIED** as of **2026-09-26** — `status = 'applied'`. Production
is already in the desired post-state and no further remote mutation is performed
by this record:

- the forward migration version `20260926120000` is present in the remote
  `supabase_migrations.schema_migrations` ledger;
- the live `public.public_article_projection_p3` view definition contains the
  `article_embedding_artifacts` join and the `coalesce(... embedding ...)`
  authority, over the unchanged gate2 36-column shape;
- the read-only counts-only semantic audit is
  `currentPublished=1258`, `projectionRows=1258`, `projectionEmbeddingNull=0`,
  `artifactBacked=1258`, `legacyOnly=872`, all mismatch counts `0`;
- the read-only bounded semantic/hybrid smoke is `4/4` pass with `oracleDrift=0`;
- the projection id count+digest is captured content-free as `count=1258`,
  `digest=8225277ff26ba0622cecfd726a07e3b8`.

The applied evidence artifact is
`artifacts/cloudflare-m7/m7.8a-semantic-authority-rollout.{json,md}` with
`mode=finalize-existing`, `status=applied`, `historyRecorded=true`,
`historyVerified=true` and `targetVersion=20260926120000`.

This step is **code/local verification only** in the sense that it performs no
schema apply, no ledger repair, no Supabase mutation, no deploy, no
`SearchRepository`/`GO-SEARCH`/`GO-D1-READ` switch, no DNS or traffic change and
no commit/push. `search_m7` remains blocked and the
`fulltext_rank_threshold_unagreed` rank-policy blocker remains from M7.7-B.

## Rollout recovery sequence (2026-09-26)

The normal `--apply` path failed closed before completing its internal apply
step. During the apply attempt the live `--allow-live-baseline` semantic counts
were captured, and the live projection embedding-NULL baseline changed from the
frozen pre-apply `872` to `0` before the internal apply step ran, so the
fail-closed gate rejected the apply. The tooling therefore did not record its own
schema apply.

The recovery was then completed with read-only steps only, in this order:

1. a read-only verification showed the live schema was already at the desired
   post-state view (gate2 36 columns, artifact-backed/coalesced embedding
   authority, `projectionEmbeddingNull=0`);
2. the remote migration ledger was reconciled manually so version
   `20260926120000` is present;
3. the new read-only `--finalize-existing` mode re-read the ledger, columns,
   semantic counts and projection identity, ran the bounded semantic/hybrid
   smoke, and wrote the applied evidence artifact.

This document does **not** assert which concurrent actor changed the view. It
records only what the read-only verification observed: the schema was already in
the desired post-state before the ledger reconciliation, and the ledger was
reconciled before the finalize-existing evidence was produced.

## Pinned contract

```text
migration.version       = 20260926120000
migration.path          = supabase/migrations/20260926120000_m7_7a_semantic_authority_projection.sql
migration.sha256        = 89159138DF2085338D6F54B3D8BA2ADBA9FE74D6F9140CC59C7C28ECBE281FE5
migration.sqlBytes      = 6567
linked.project.ref      = eawgnnytdvjuwhczyhlq
linked.project.name     = worldcons
gate2.projection.columns= 36 columns, exact gate2 attnum order
```

The 36-column order is frozen from the existing gate2 migration
(`20260903130000_constitutional_case_catalog_gate2.sql`): only the `embedding`
expression changes in the forward migration.

## 1. Rollout modules (`lib/cloudflare/search-authority/*`)

- `migration-contract.ts` — pins the version/path/SHA-256, the linked
  `worldcons` project identity (`supabase/.temp`), the 36-column gate2 order, the
  frozen plan baseline counts (1258 current/projection/artifact-backed, 872
  projection-embedding-null, 872 legacy-only, 0 mismatches) and the staged
  rollback path. `assertMigrationSha256` / `assertProjectionColumns` /
  `readLinkedProjectIdentity` fail closed.
- `migration-inventory.ts` — direct read-only
  `supabase_migrations.schema_migrations` ledger plus a best-effort
  `supabase migration list --linked` cross-check (used "where reliable"), the
  pending-set computation, and `assertPendingSetIsExactlyTarget` (the pre-apply
  pending set must be exactly `[20260926120000]`; the target must be absent; an
  extra local migration fails closed).
- `preflight-sql.ts` — authored read-only SQL: live projection columns/order,
  target-version absence, the counts-only provenance audit, and a content-free
  projection id **count + md5 digest**. It also carries the fail-closed baseline
  evaluation and the post-apply validation contract.
- `apply-plan.ts` — builds the ONLY apply invocation:
  `supabase db query --linked -o json <exact migration bytes>`. A deny-list
  rejects `db push`, `migration up` and `--include-all`; `assertApplyGate`
  requires the explicit `--apply` flag **and** an in-process passed preflight.
- `migration-repair.ts` — the post-apply-only ledger-reconciliation contract:
  the exact `migration repair --linked --status applied <version>` argv builder and
  guard, the "only after validated apply" eligibility gate, the scope gate that
  rejects `--record-history` outside `--apply`, and the `verifyHistoryRepair` /
  `evaluateHistoryRepair` re-read/verify decision (`history_repair_failed`).
- `finalize-existing.ts` — the READ-ONLY recovery contract: the
  `--finalize-existing` flag, the finalized post-state constants
  (`CurrentPublished = projection = artifactBacked = 1258`, embedding NULL `0`,
  legacy-only `872`, mismatches `0`), the check order, the
  `evaluateFinalizeExistingState` validation (columns, exact counts, identity,
  target present, pending empty, `oracleDrift=0`) and the machine-checkable
  `FINALIZE_EXISTING_FORBIDDEN_OPERATIONS` / `assertFinalizeExistingReadOnly`
  guard that forbids any schema-apply or ledger-repair invocation.
- `smoke.ts` — a frozen, bounded set of semantic/hybrid cases resolved through
  the M7.6 oracle seam; `oracleDrift` must be 0.
- `evidence.ts` — the content-free artifact contract, a recursive
  vector/URL/long-text/forbidden-key guard and the JSON+markdown renderers. The
  evidence carries `recoveredExistingState` and `preIdentityAvailable`; on the
  recovery path `preIdentity=null` and the post-apply `rowCountUnchanged` /
  `idDigestUnchanged` are `null` (never a fabricated pre/post equality).
- `index.ts` — barrel.

## 2. Operator CLI — `scripts/semantic-authority-rollout.ts`

Dry-run by default. Modes:

```text
pnpm m7.8a:dry-run            # offline: prints the plan + read-only SQL, connects to nothing
pnpm m7.8a:preflight          # read-only linked production preflight
pnpm m7.8a:report             # read-only preflight + writes the local evidence artifact only
pnpm m7.8a:apply              # atomic: preflight -> exact-bytes apply -> validation -> ledger repair -> evidence
pnpm m7.8a:apply:diagnostic   # raw --apply for diagnostics: validated apply + evidence, NO ledger repair
pnpm m7.8a:smoke              # read-only bounded semantic/hybrid smoke
pnpm m7.8a:finalize-existing  # READ-ONLY: verify an already-applied state + write applied evidence
# optional modifiers:
--report                      # write the LOCAL content-free evidence artifact; never mutates the ledger
--record-history              # POST-APPLY ONLY: reconcile the remote migration ledger after validation
--allow-live-baseline         # preflight captures same-day counts, mismatches still must be 0
```

`--apply` re-runs **every** preflight check in the same process, then executes
ONLY the exact bytes of the pinned migration through `supabase db query --linked`
inside the file's own `begin; ... commit;` transaction. It never uses
`schema-push`, `migration-up` or `include-all` tooling.

`--report` (local evidence) and `--record-history` (remote migration-ledger
reconciliation) are deliberately distinct:

- **`--report`** writes
  `artifacts/cloudflare-m7/m7.8a-semantic-authority-rollout.{json,md}`. It is
  valid in read-only preflight and never mutates Supabase.
- **`--record-history`** is valid **only with `--apply`** and only **after** the
  exact-SQL apply commits **and** every post-apply validation/smoke gate passes.
  It runs exactly
  `supabase migration repair --linked --status applied 20260926120000`, then
  directly re-reads `supabase_migrations.schema_migrations` (with an optional
  `supabase migration list --linked` cross-check) and requires the target version
  to be present. It is **never** the schema-apply mechanism. If the repair fails or
  the ledger does not show the target applied, the CLI reports
  `history_repair_failed` and does **not** roll the schema back automatically.
  `pnpm m7.8a:apply` runs `--apply --record-history --report`, so validated
  apply + ledger repair + evidence is atomic from the operator's perspective;
  `pnpm m7.8a:apply:diagnostic` deliberately omits the ledger repair.

A successful `--apply` writes the evidence artifact unconditionally (the
diagnostic surface writes evidence but skips the ledger); read-only evidence is
opt-in via `--report`. `--finalize-existing` writes the applied evidence artifact
unconditionally (it is the whole point of the recovery mode).

## 3. Preflight (read-only, fail-closed)

1. linked ref/`worldcons` identity;
2. exact migration SHA-256 of the on-disk bytes;
3. remote target version absent;
4. pending set exactly `[20260926120000]` (direct ledger; CLI cross-check where
   reliable);
5. live `public_article_projection_p3` columns/order exactly the 36 gate2 columns;
6. provenance counts baseline matching the current plan, or — with
   `--allow-live-baseline` — same-day counts captured while mismatches stay 0;
7. pre-id count + md5 digest captured.

No vectors, text, URLs or ids are emitted: the provenance audit is counts-only
and the identity is a count + digest.

## 4. Post-apply validation contract

Applying is allowed only when all of the following hold after the exact-bytes
apply:

- columns unchanged (same 36 columns, same order);
- `projection_embedding_null_count = 0`;
- row count and id digest unchanged from the pre-apply capture;
- artifact-backed = current published = projection;
- every provenance mismatch = 0;
- bounded semantic/hybrid smoke `oracleDrift = 0`.

Any failure fails the rollout closed; a failed validation **never** triggers the
migration-ledger repair, and the schema is left in place (no auto-rollback).

## 4a. Migration-ledger reconciliation (`--record-history`)

After a validated apply, `--record-history` runs exactly:

```text
supabase migration repair --linked --status applied 20260926120000
```

through the same bounded Windows-safe child-process invocation builder as the
query path (`spawn` with `shell:false`; a `.cmd`/`.bat` shim is routed through
`cmd.exe /d /s /c` with a safely-quoted verbatim command line). stdout is bounded
and stderr is drained but never recorded, so credentials/connection text never
reach a log or error message. The argv is guarded to be exactly
`migration repair --linked --status applied <version>` and must also pass the
shared forbidden-tooling deny-list, so repair can never smuggle a schema apply.

The ledger is then re-read directly (`select version from
supabase_migrations.schema_migrations`) and the target must be present; the local
pending set must be empty; where the CLI cross-check is reliable it must agree.
`historyRecorded` is true only when the repair command exits 0; `historyVerified`
is true only when the re-read ledger proves the target applied. A failure reports
`history_repair_failed` and leaves the schema untouched.

## 4b. Read-only finalize-existing recovery (`--finalize-existing`)

`--finalize-existing` is the recovery/verification surface for an
**already-applied** schema + migration-ledger state (the 2026-09-26 rollout
recovery). It is **read-only**: it NEVER executes migration SQL (no
`planSemanticAuthorityApply` / `db query --linked <migration-sql>`) and NEVER
runs `migration repair`. Its only writes are the LOCAL evidence files.

It validates, fail-closed:

1. linked `worldcons` identity and the on-disk migration SHA-256;
2. the target version `20260926120000` IS present in the direct
   `schema_migrations` ledger (and the CLI migration list where reliable);
3. the pending set excludes the target and is empty;
4. the live projection columns are exactly the 36 gate2 columns;
5. the post-state semantic counts are exactly `currentPublished=1258`,
   `projectionRows=1258`, `projectionEmbeddingNull=0`, `artifactBacked=1258`,
   `legacyOnly=872` and all provenance mismatch counts `0`;
6. the content-free projection id count + md5 digest is captured;
7. the existing bounded semantic/hybrid smoke passes with `oracleDrift = 0`.

Because no pre-apply capture exists on this path, the evidence explicitly marks
`recoveredExistingState=true` and `preIdentityAvailable=false`, stores
`preIdentity=null` and leaves `postApply.rowCountUnchanged` /
`postApply.idDigestUnchanged` as `null`. It never fabricates a pre/post digest
equality. `historyRecorded` and `historyVerified` are true only because the
direct ledger re-read proves the target applied; no repair command is run.

The read-only property is machine-checked: `FINALIZE_EXISTING_FORBIDDEN_OPERATIONS`
lists the mutating operations and `assertFinalizeExistingReadOnly` rejects them,
and `pnpm test:m7.8a` source-scans the `runFinalizeExisting` /
`assembleFinalizeExistingEvidence` block to prove it contains no
`planSemanticAuthorityApply`, `buildSemanticAuthorityApplyArgs`,
`buildMigrationRepairArgs`, `migration repair` argv or migration-SQL runner call.

## 5. Bounded semantic/hybrid smoke

`smoke.ts` freezes four authored, bounded cases (two `semantic`, two `hybrid`,
`limit=5`) anchored on published article ids from the M7.7 v4 authoritative set.
The operator CLI calls the current production ranked RPC
`worldcons_ranked_search_page_v1` read-only and resolves each case through the
M7.6 `resolveSearchCanaryOracleMode` seam. If the production projection embedding
is still NULL the seam selects `artifact-reference` with `drift=true`, so a
non-zero `oracleDrift` fails the gate. The final production smoke is `4/4` pass
with `oracleDrift=0`.

## 6. Staged rollback candidate (never applied, never moved)

`supabase/rollback-candidates/20260927120000_m7_8_rollback_semantic_authority_projection.sql`

- deliberately **outside** `supabase/migrations`, so it can never join the
  pending migration set or be discovered by migration tooling;
- restores the gate2 bare `v.embedding` authority with the same
  column list/order, the same freshness/catalog predicate, `security_barrier`,
  the same anon/authenticated/service_role grants and `notify pgrst`;
- fails closed unless the live view is in the artifact-backed forward state
  (`M78_ROLLBACK_VIEW_MISSING` / `M78_ROLLBACK_VIEW_COLUMN_DRIFT` /
  `M78_ROLLBACK_SOURCE_STATE_MISSING`).

It is staged only: M7.8-A does not apply or move it.

## 7. Content-free evidence artifact

`artifacts/cloudflare-m7/m7.8a-semantic-authority-rollout.{json,md}` (contract in
`evidence.ts`; written by `--report`, and unconditionally by a successful
`--apply` or by `--finalize-existing`). The report carries counts, ids/digests,
hashes, booleans, modes and states only. A recursive guard rejects vectors, URLs,
over-long text and forbidden keys before anything is serialized. Apply and
finalize-existing evidence additionally carries a content-free history block:

```text
history.historyRecorded   # true only when the ledger records the target applied
history.historyVerified   # true only when the re-read ledger proves the target applied
history.targetVersion     # 20260926120000
history.applied           # post-repair / post-finalize direct-ledger applied state
history.pendingVersions   # pending local versions (must be empty when verified)
```

Preflight (`--report`) evidence has `history = null`, proving read-only evidence
never mutates the migration ledger. Recovery evidence additionally carries:

```text
recoveredExistingState    # true on the finalize-existing recovery path
preIdentityAvailable      # false on the recovery path
preIdentity               # null on the recovery path (no fabricated equality)
postApply.rowCountUnchanged / idDigestUnchanged   # null on the recovery path
```

The checked-in artifact is `mode=finalize-existing`, `status=applied`,
`recoveredExistingState=true`, `preIdentityAvailable=false`,
`historyRecorded=true`, `historyVerified=true`, smoke `4/4` with `oracleDrift=0`.

## 8. Tests

- `tests/m7.8a-semantic-authority-rollout.test.ts` (`pnpm test:m7.8a`, 23 cases):
  the hash/version/path pin, the 36-column gate2 order, the read-only ledger, the
  pre-apply pending-set exactly-`[target]` gate (including an extra local file),
  the CLI inventory parser, the exact-file `db query --linked` apply plan, the
  forbidden-tooling deny-list (and a script-source scan), the
  apply-flag/preflight gate, dry-run-default/mode coverage (including
  `--finalize-existing`), the frozen/live baseline gate, the post-apply
  count+digest/columns/artifact-backing/mismatch/drift gates, the M7.6-seam smoke
  drift gate, the read-only preflight SQL, the rollback-candidate location/state,
  the content-free evidence guard, the exact migration-repair argv guard, the
  repair-only-after-validated-apply gate, the preflight-`--record-history`
  rejection, the re-read/verify ledger requirement, the safe package scripts, and
  the finalize-existing read-only proof: the forbidden-operation guard, a
  source-scan that the `runFinalizeExisting` block contains no schema-apply or
  ledger-repair invocation, the finalized post-state validation (target present,
  pending empty, exact `1258/1258/0/1258/872/0`, `oracleDrift=0`) and the
  recovered-state evidence (null pre-identity, null pre/post comparisons,
  `historyRecorded/historyVerified=true`, artifact JSON/MD render consistency).

## 9. M7.8-B rank-policy governance + disjoint v5 holdout

M7.8-B authors the rank-policy **surfaces only**: no policy is chosen and no
holdout evidence is produced.

- `holdout.ts` — the additive, content-free v5 holdout candidate pool, a
  deterministic selection and the frozen `holdoutHash 1452c95c29fba160`. It is
  DISJOINT from the active v4 corpus (`corpusHash ed18add749fe4a23`) by
  normalized `(category, query, filters)` and never re-uses a v4 case whose rank
  outcome was read; the harness asserts disjointness before any query.
- `corpus.manifest.v5-holdout.json` — the frozen 18-case v5 holdout manifest
  (8 strict anchors + 10 informational), byte-checked against
  `buildRankHoldoutManifest()`.
- `decision.ts` — the typed, fail-closed decision record; the checked-in
  `docs/operations/worldcons-m7.8b-rank-policy-decision.template.json` is
  `undecided` and is refused before any linked query.
- `equivalence.ts` — the product-neutral E1-E4 candidate-coverage invariant
  evaluator (non-numeric; order/set/overlap metrics stay informational only).
- `scripts/d1-fts-parity.ts --manifest=holdout-v5 --decision=<path>` — the
  additive read-only holdout mode, bound to `decisionHash + holdoutHash`,
  fail-closed before any query and read-only by construction (no `--apply`).

The v4 manifest/hash and every v1/v2/v3 archive remain byte-for-byte unchanged.
No policy is chosen: the `fulltext_rank_threshold_unagreed` blocker and the
`GO-SEARCH` block remain. The human signing procedure is documented in
`docs/operations/worldcons-m7.8b-rank-policy-decision-instructions.md`.

## Local verification

```text
pnpm test:m7.8a     # 23/23 pass
pnpm test:m7.7a     # 11/11 pass (regression)
pnpm typecheck      # pass
pnpm lint           # pass (0 errors; pre-existing wrangler-tmp warnings only)
git diff --check    # pass
pnpm m7.8a:dry-run  # offline plan only; no connection
pnpm test:m7.8b     # 21/21 pass
pnpm m7.8b:holdout -- --decision=<path> --dry-run  # offline; refuses an undecided record
```

No remote schema apply, no `supabase migration repair` and no Supabase mutation
were performed while producing this record.

## Boundaries preserved

- Production post-state is APPLIED/VERIFIED; this record performs no further
  remote mutation.
- `--record-history` is a post-apply ledger reconciliation only; it is never the
  schema-apply mechanism, is rejected outside `--apply`, and a failure reports
  `history_repair_failed` without auto-rolling back the schema.
- `--finalize-existing` is read-only: it never executes migration SQL, never runs
  `migration repair`, and only writes local evidence files; it never fabricates a
  pre-apply digest comparison.
- No Supabase mutation, no deploy, no `SearchRepository`/`GO-SEARCH`/`GO-D1-READ`
  switch, no DNS or traffic change and no commit/push.
- The rollback candidate is staged outside `supabase/migrations` and is never
  applied or moved.
- No generic lexical acceptance threshold is invented; `fulltext_rank_threshold_unagreed`
  remains and `GO-SEARCH` stays blocked.
- M7.8-B authors surfaces only: no policy is chosen, the v5 holdout is not run, no
  `m7.8b-fts-parity-holdout.{json,md}` evidence is created, and the
  `fulltext_rank_threshold_unagreed` blocker remains.
