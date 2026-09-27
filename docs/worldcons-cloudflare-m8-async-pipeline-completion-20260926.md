# WorldCons Cloudflare M8 — Async pipeline migration status

Date: 2026-09-26
Branch: `codex/m7-go-search` (in-place; no new branch)
Base HEAD: `e3fc2c52c4ea51939d2af245d0870488aeaade5a`
Earlier checkpoint HEAD: `4d62f8b` (`feat: record M7 GO-SEARCH readiness`)

## Status

**M8 PER-KIND CANARY GATE IMPLEMENTED + REHEARSED; SCHEDULER RESTORED TO
DISABLED; REQUEST-GOVERNOR / RESTART-RECOVERY / NO-DUPLICATE EVIDENCE ADDED;
GO-ASYNC ACCEPTANCE RECORDED WITH THE DOCUMENTED DLQ BODY-ATTRIBUTION
OBSERVABILITY LIMIT; SCHEDULER REMAINS DISABLED.**

The M8 async control plane (Cron + Queues + Workflows) and the Browser Run
crawler transport are implemented and deployed as isolated resources. The
deployed `worldcons-ingest` final resting version `510507c0-de82-4019-a1dd-
d2a1f8f37cf4` has `M8_SCHEDULER_ENABLED=false` and `M8_ENABLED_KINDS=admin-
health`, so every Cron, Queue and Workflow entry point fails closed or
skips/acks without triggering live GitHub execution.

This step adds a **per-kind activation gate** after a prior global boolean let
the scheduled `*/15` cron also dispatch non-canary kinds. It also performed a
controlled remote rehearsal (single admin-health kind only) and then restored
the disabled safety state. The Hive worker itself performed no commit or push;
the controller checkpoints the reviewed result after this evidence record is finalized.

This milestone deliberately does **not** cut over the existing GitHub Actions
long-running Node executor. GitHub Actions remains the compatibility executor
for full Node/Crawlee/Playwright workloads; a fully Cloudflare-executing
pipeline would require Containers and is documented as a later task
(see "Post-main sequence" and "Current limitations").

## 0a. Workflow-ID bug and per-kind gate (2026-09-26 follow-up)

### Workflow instance ID bug

The first scheduler-true deploy `d3629a2a-d0c2-488b-98bf-6ce50a2845a6` failed
because the Workflow instance id was the raw idempotency key
(`m8:<kind>:<minute>`), and Cloudflare Workflow ids reject `:`. The local fix
(present in this worktree and awaiting the controller checkpoint) maps every character
outside `[A-Za-z0-9_-]` to `-` and caps the id at 100 characters in
`workflowInstanceId()` (`lib/cloudflare/async-pipeline/contracts.ts`). The GitHub
dispatch input `m8_idempotency_key` keeps the original colon-form key, so
executor identity is unchanged. The fixed scheduler-true deploy was
`11f20792-71ec-49e3-8608-b126e76c05f2`.

### Unintended global-gate executions

A real admin-health dispatch (GitHub run `36230534033` at
`2026-09-26T08:41:29Z`) reached GitHub run-only because the single global
boolean also let the scheduled `*/15` cron dispatch:

| Workflow | Run ID | Created | Conclusion |
| --- | --- | --- | --- |
| `admin-job-worker.yml` | `36230757274` | `2026-09-26T08:45:52Z` | success |
| `admin-watchdog.yml` | `36230755240` | `2026-09-26T08:45:50Z` | success |

Both succeeded, but this violated the intended "admin-health only" canary
isolation. Fail-safe was restored afterwards at `2620360d-56f1-413d-b0ab-
d0d019b2c10d` (`M8_SCHEDULER_ENABLED=false`).

### Per-kind allowlist gate

`M8_ENABLED_KINDS` (comma-separated, exact `M8TaskKind` values) is now parsed by
`parseM8EnabledKinds()` / `resolveM8RolloutGate()` / `isM8KindEnabled()`:

- `*` means all known kinds, but **only** when it is the sole non-empty entry;
- an absent/empty allowlist is **invalid** and fails closed — enabling the
  scheduler never implicitly enables every kind;
- any unknown kind, or `*` mixed with explicit kinds, is invalid;
- an invalid policy denies every kind at every entry point;
- the `M8_SCHEDULER_ENABLED` master switch still gates everything.

Gate application:

- `scheduled()` enqueues only allowed kinds; if none are allowed it logs
  `m8_schedule_skipped` / `no_enabled_kinds` and returns.
- `queue()` partitions each batch: malformed payloads retry (bounded) toward the
  DLQ; schema-valid but gate-blocked messages are **acked without dispatch**
  (they must not spin forever or reach the DLQ merely because a rollout gate is
  closed); eligible messages create Workflow(s) then ack.
- `Workflow.run()` re-checks the kind and returns `{ dispatched: false }` without
  dispatching when blocked.

### Controlled remote rehearsal (admin-health only)

| Field | Value |
| --- | --- |
| Canary deploy (scheduler=true) | `e5f23c8f-eed1-46e3-a894-c3ef4c953d0c` |
| Allowlist | `admin-health` only |
| Queue message | `m8:admin-health:2026-09-26T09:00:00.000Z` |
| Workflow instance id | `m8-admin-health-2026-09-26T09-00-00-000Z` |
| Workflow status | `Completed`, dispatch step `status:204` |
| GitHub run | `36232371374` at `2026-09-26T09:18:26Z` (`workflow_dispatch`) |
| GitHub conclusion | failure at `Produce redacted health evidence` |
| Failure reason | `hardViolations=lifecycle.review,publication.parity` |
| Replay | same message resent; **no** second Workflow instance, **no** second GitHub run |
| Restored safety deploy | `10e27ad5-6660-43ba-8b88-df5e2a428c01` (`scheduler=false`, allowlist `admin-health`) |

The GitHub failure is the **known P5 application-data health failure**
(`lifecycle.review`, `publication.parity`) — queue/heartbeat/retry/outbox/source
freshness were healthy. It is separated here from M8 transport, which succeeded
end-to-end (Queue → Workflow → GitHub `workflow_dispatch`, exactly once).

### Operator canary tooling

`pnpm m8:canary` (`scripts/m8-async-canary.ts`) validates and prints the current
policy and the deterministic Queue message, Workflow instance id and GitHub
dispatch mapping. It is dry-run by default, never dispatches GitHub directly,
refuses to publish a kind the resolved policy blocks, and `--apply` posts exactly
one message through the Queue API (credentials from
`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` only).

### Retry / DLQ status

A deliberately invalid, non-dispatchable payload
(`kind=not-a-real-kind`, key `m8:invalid:gate-probe`) was injected to exercise
the retry path without any GitHub dispatch or application-data mutation. The main
queue showed a backing-off backlog entry immediately after injection. The
`worldcons-async-dlq-v1` queue held two pre-existing entries (one old
`admin-health` message that reached the DLQ under the OLD disabled gate, and one
prior forged-payload probe). **Automatic DLQ transition for the new injected
probe remains OPEN**; exact next procedure is in
`artifacts/cloudflare-m8/per-kind-canary-rehearsal-20260926.json`
(`retryDlq.nextCommand`). No retry timings were changed for the proof.

## 0b. GO-ASYNC acceptance evidence (2026-09-26 follow-up)

This step (base HEAD `56fd89d02e03193b402c7da6dcba9f3be3accda4`) closes as many
remaining `GO-ASYNC` items as truthfully possible **without production data
mutation**. The scheduler stayed disabled (`M8_SCHEDULER_ENABLED=false`,
`M8_ENABLED_KINDS=admin-health`) throughout, no publication job was triggered, and
no Supabase/D1/application data was written. Full content-free evidence is in
`artifacts/cloudflare-m8/go-async-acceptance-evidence-20260926.json`.

### Retry -> DLQ read-only re-observation

Read-only Cloudflare queries (operator OAuth session; no send/ack/retry/purge)
observed:

| Signal | Value |
| --- | --- |
| `worldcons-async-v1` backlog | `0` (was `1` at the last canary record) |
| `worldcons-async-dlq-v1` backlog | `3` (was `2`) |
| DLQ oldest message | `2026-09-26T08:38:18.024Z` |
| Consumer policy | `max_retries=3`, `retry_delay=60`, `max_concurrency=1`, DLQ bound |

Cloudflare GraphQL analytics (`AccountQueueMessageOperationsAdaptiveGroups`) show
three main-queue `DeleteMessage` outcomes of type **`dlq`**
(`08:38Z`, `09:03Z`, `09:35Z`) and three matching DLQ `WriteMessage` events. This
demonstrates the automatic retry -> DLQ transition path is active and bounded
under the unchanged retry policy.

**Limitation (kept OPEN):** Cloudflare exposes **no read-only message-body peek**
for a push-consumer queue — `GET .../messages` returns HTTP 405,
`/messages/preview` returns `10405` for this auth scheme, and
`POST .../messages/pull` returns 405 "messages cannot be pulled unless http_pull
mode is enabled". The injected probe (`m8:invalid:gate-probe`) therefore **cannot
be tied by body to a specific DLQ write from the API**, so its exact automatic
transition is recorded as `OBSERVED_ACTIVITY_UNATTRIBUTED_OPEN`. The message was
not purged or deleted, so the evidence remains available to a future
`http_pull`-enabled or dashboard-based inspection.

### Request-governor parity

The per-source request-governor contract (`lib/crawler/types.ts`,
`lib/crawler/request-governor.ts`, `lib/backfill/source-request-governor.ts`) was
traced through the M8 execution path. Two real gaps were fixed with the smallest
safe propagation, and limits were not weakened:

1. `lib/crawler/cloudflare-browser-run-client.ts` now wraps the Browser Run
   navigation in `withCrawlerRequestPermit`, so a governed caller consumes a
   per-source permit before Browser Run is invoked.
2. `lib/ingest/fetch.ts` `fetchRawItem` previously **dropped**
   `requestGovernor` when escalating to Playwright/Browser Run (the `us-scotus`
   fetch path). It now forwards the governor to both the primary `crawlUrl` and
   the browser escalation.

Runtime-neutral tests in `tests/m8-async-pipeline.test.ts` assert the Browser Run
permit acquire/release round-trip and that `fetchRawItem` never drops the
governor. No live crawler publication occurred.

### Restart / recovery

The queue-consumer decision was collapsed into two pure, runtime-neutral helpers
in `lib/cloudflare/async-pipeline/contracts.ts` — `dedupeM8WorkflowCreates()` and
`planM8QueueBatch()` — and `workers/async-pipeline/src/index.ts` now dispatches
`planM8QueueBatch(...).creates`. Tests cover: replay after a consumer restart
yields the same Workflow instance id; identical identities collapse to one create
per batch; distinct minutes remain distinct; gate-closed valid messages are acked
with no dispatch; malformed payloads stay on the bounded (`delaySeconds=300`)
retry path toward the DLQ; and a Workflow re-entry cannot create a second GitHub
side effect for the same deterministic identity.

### No-duplicate publication

The M8 identity trace is now explicit and tested end-to-end in code:
`m8:<kind>:<minute>` -> sanitized Workflow id (colon form preserved for the
GitHub input) -> `resolveP1InvocationIdentity()` (`sha256(m8 key).slice(0,24)`)
-> `p1CommandIdentities()` -> `p1:<identity>:<commandType>` +
`p1:<cohort>:<commandType>` -> `admin_submit_command_v3`'s
`unique(command_type, idempotency_key)` and active-run `dedupe_key`. Two identical
M8 identities therefore cannot produce two distinct publication command/dedupe
identities. When an M8 identity is present it is the stable source of truth; when
it is absent the pre-existing GitHub run/attempt (or local-clock) fallback is
preserved. The helper fails closed with `p1_invocation_identity_invalid` only
if the resolved invocation identity passed into command-identity construction is
blank/invalid. No real publication was triggered.

### P5 hard violations (read-only diagnosis)

The exact read-only redacted artifact produced by GitHub run `36232371374`
(`scripts/admin-health-p5.ts`) was retrieved and inspected; live counts were not
re-queried because no Supabase credential is available in this worktree and the
task forbids data mutation.

- **`lifecycle.review`** (`critical`, value `1403602s`, warning `86400`, critical
  `259200`): `oldestReviewAgeSeconds` over `articles where
  lifecycle_attention_state in ('active','anomaly') or lifecycle_review_state =
  'needs_review'`; backlog `5`, unresolved anomalies `0`. **Data backlog**, not a
  code defect.
- **`publication.parity`** (`critical`, value `26` = `parityMismatchCount 14` +
  `quarantineCount 12`, threshold `0`): comparison of
  `articles(status='summarized' and source_metadata#>>'{collection,publishable}'
  = 'true')` (`1272`) against `public_article_projection_p3` (`1258`), plus
  unresolved `article_publication_quarantine_p3`. Identity digests differ
  (`5d9230…` vs `6d58bd…`). **Data backlog** (legacy-public rows not yet
  projected + unresolved quarantine), not a code defect.

Remediation (not performed here) is recorded in the evidence artifact: run the
existing flag-gated P3 projection/republish path for the mismatched articles,
resolve the quarantine rows via the existing
`admin_governance_p5_quarantine_resolution` path, and triage the lifecycle
backlog; then re-run `pnpm admin:health:p5` read-only requiring
`hardViolationKeys=[]`.

## 0c. P5 production-data maintenance attempt (2026-09-26 follow-up) — BLOCKED, no mutation

This step attempted the M8 follow-up P5 production-data maintenance described in
section 0b using only the repository's existing bounded/flag-gated operator paths.
Every candidate path was dry-run inside an explicitly `ROLLBACK`-ed read/write
transaction and then re-read against live data. **All three maintenance classes
were aborted without any production mutation**, because each would either expand
the quarantine register past the already-recorded backlog, require weakening a
fail-closed safeguard, or require a human semantic decision. The P5 result is
unchanged: `hardViolationKeys=["lifecycle.review","publication.parity"]`.

The M8 scheduler stayed disabled (`M8_SCHEDULER_ENABLED=false`,
`M8_ENABLED_KINDS=admin-health`), `M8_ENABLED_KINDS` was not broadened, the DLQ
was not purged, and no migration, retry policy, search/M7 authority or unrelated
data was touched.

### Live rows re-read before and after (identical)

| Signal | Before | After |
| --- | --- | --- |
| `legacyPublicCount` | 1272 | 1272 |
| `explicitPublicCount` (projection) | 1258 | 1258 |
| `legacyOnlyCount` (parity mismatch) | 14 | 14 |
| `projectionOnlyCount` | 0 | 0 |
| `article_publication_quarantine_p3` total | 13 | 13 |
| unresolved quarantine | 12 | 12 |
| quarantine resolutions | 1 | 1 |
| lifecycle backlog | 5 | 5 |
| oldest review age (s) | 1415272 | 1415272 |
| unresolved lifecycle anomalies | 0 | 0 |

All verification queries ran in read-only sessions or in transactions that were
explicitly rolled back; the post-run aggregate is identical to the pre-run
aggregate. No row was inserted, updated or deleted.

### 1. Publication parity (14 legacy-only + 12 quarantine) — BLOCKED (expansion + safeguard)

The existing bounded P3 path is `article_publication_backfill_batch_p3`
(`pnpm admin:publication:p3 -- --backfill`). It is a **legacy reconciliation**
scan, not a targeted mismatch repair: with `p_after_id=null` it re-walks every
article from the first id in bounded batches. A rolled-back `limit=2000` batch
produced:

| Field | Value |
| --- | --- |
| `selected_count` | 1277 |
| `mapped_count` | 0 |
| `quarantined_count` | 81 |
| `unchanged_count` | 1201 |
| quarantine total (would-be) | 94 (from 13) |
| new `backfill.authority_rejected` | 62 |
| new `backfill.existing_state_conflict` | 14 |
| `backfill.lifecycle_attention_not_clear` | 17 (from 12) |

That is an **unexpected expansion** of the quarantine register (13 -> 94), so the
batch was aborted before commit, exactly as the operating instruction requires.

The mismatch cannot be repaired by a direct projection/republish transition
either. Driving the 14 legacy-only articles through the existing
`article_publication_transition_p3(... 'published' ...)` path one row at a time
was rejected for **all 14** with a single distinct error:

```
transitions_ok=0 transitions_rejected=14 distinct_errors={ARTICLE_P3_FRESHNESS_UNKNOWN}
```

Root cause (read-only): the v4 publication guard
`article_p3_publication_guard_v4()` (migration `20260903130000`, trigger
`article_publications_p3_guard_v4_trigger`) raises `ARTICLE_P3_FRESHNESS_UNKNOWN`
whenever a published version has `version_role is null` and no
`legacy_version_freshness_classifications_v4` row with `freshness='current'`.
For all 14 rows the current publication version is a `p3.article.v1` null-role
version created between `2026-09-05` and `2026-09-26`, i.e. **after** the
one-time `2026-09-03` gate2 reconciliation that classified every then-existing
null-role version as `current`. The classification table has 3236 rows, all
stamped `2026-09-03`; the 14 target versions (plus other post-`2026-09-03`
null-role versions) have zero classification rows.

The **only** statement that inserts into
`legacy_version_freshness_classifications_v4` in the repository is the one-time
`DO` block in `20260903130000_constitutional_case_catalog_gate2.sql`; no runtime
function or operator CLI classifies versions. Repairing the parity mismatch would
therefore require either a new/applied migration and runtime classification path
(both explicitly out of scope: "do NOT alter ... migrations") or bypassing the
fail-closed freshness guard (explicitly forbidden: "any need to weaken
safeguards"). The 12 unresolved quarantine rows are a separate issue (below).

### 2. Unresolved quarantine (12 rows) — BLOCKED (no operator writer + human decision)

All 12 unresolved rows are `anomaly_code = backfill.lifecycle_attention_not_clear`
with `legacy_public = false`, and all 12 are already inside the public projection,
so they are not part of the identity mismatch. There is **no existing bounded
operator path** to write `article_publication_quarantine_resolutions_p3`: the file
named `20260713093000_admin_governance_p5_quarantine_resolution.sql` only
re-creates the P5 health view (so `quarantineCount` counts only unresolved rows);
it defines no resolution function, route or CLI. The only resolution insert in the
repository is the one-time `DO` block in
`20260713090000_article_publication_p3_review_eligibility.sql`, which
auto-resolves only `backfill.public_review_ineligible` rows with `legacy_public =
true` that are already eligible and publishable. The single existing resolution
row is exactly such a row (`resolution.completed_processing_is_publishable`).

Resolving a `backfill.lifecycle_attention_not_clear` row requires choosing a
`resolution_code` that asserts a **human semantic decision** about why the
article's outstanding collection attention is acceptable, and the underlying
articles do not have `lifecycle_attention_state='clear'`. Per the operating
instruction this is left unresolved and recorded as a blocker rather than
guessed.

### 3. Lifecycle review backlog (5 rows) — BLOCKED (bounded path is a no-op + human decision)

The existing bounded lifecycle path is `article_lifecycle_backfill_batch_p2`
(`pnpm admin:lifecycle:p2 -- --backfill`). A rolled-back `limit=2000` batch
produced `selected=1277, mapped=0, anomaly=0, unchanged=1277, batch_complete=true`
and left the backlog at 5 -> 5: it is a no-op for the current data.

All 5 backlog rows are `source_key='es-tribunal-constitucional'`,
`status='metadata_only'`, `lifecycle_attention_state='active'`,
`lifecycle_attention_code='collection.metadata_only'`, oldest raised
`2026-09-10T03:25:18Z` (~1,415,272 s). Clearing the attention state requires the
P2 transition with `attention_operation='clear'` plus explicit resolution codes,
and no bounded path fetches the missing source text (the rows are
metadata-only). Deciding whether each is still collectable or should be closed
private is a **human semantic decision**, so the backlog was left unresolved and
recorded as a blocker.

### Outcome

No P5 production-data maintenance was applied. `GO-ASYNC` therefore remains
**OPEN**; `hardViolationKeys` is still `["lifecycle.review","publication.parity"]`.
The M8 scheduler was not enabled, `M8_ENABLED_KINDS` was not broadened, the DLQ
was not purged, and no migration, retry policy, search/M7 authority or unrelated
data was touched. The only changes in this step are this document and
`artifacts/cloudflare-m8/go-async-acceptance-evidence-20260926.json`.

## 0d. P5 forward-fix + GO-ASYNC acceptance (2026-09-27)

Section 0c is retained as the record of the **first, correctly aborted**
maintenance attempt. Subsequent read-only diagnosis established that its
conclusion was too broad: the existing whole-table P2/P3 backfills were indeed
unsafe for these rows, but the blockers were machine-resolvable through narrow
forward-fixes without weakening the v4 freshness guard or inventing publication
or review decisions.

Two new timestamped forward migrations were created; no existing migration was
edited:

- `20260927023756_m8_p5_publication_parity_forward_fix.sql`
- `20260927025116_m8_p5_terminal_metadata_lifecycle.sql`

Both were first exercised against production inside explicit `ROLLBACK`
transactions, then listed as the **only** pending migration by
`supabase db push --linked --dry-run --yes`, and only then applied.

### Publication parity + quarantine

The 14 legacy-public rows missing from `public_article_projection_p3` were all
post-Gate2 legacy P3 captures whose then-current immutable P3 version had no
runtime freshness classification. Their stale draft P3 version also lacked the
current legacy article's summary, so simply classifying and publishing that old
version was not safe.

The forward-fix therefore:

1. adds an AFTER INSERT classifier for new `p3.article.v1`, null-role legacy
   versions, preserving the existing `ARTICLE_P3_FRESHNESS_UNKNOWN` guard;
2. catches up unclassified immutable legacy versions using the same
   `current / legacy_same_version` semantics as the original Gate2
   reconciliation;
3. repairs only legacy-public, projection-missing, draft rows with no current P3
   backfill anomaly by calling `article_publication_transition_p3` with
   `captureLegacy=true`, creating a fresh immutable P3 version from the current
   article before publishing;
4. resolves only stale `backfill.lifecycle_attention_not_clear` quarantine
   rows whose current lifecycle attention is already `clear` and whose article
   is already present in the public projection.

The pre-commit simulation predicted
`projection 1258 -> 1272`, `mismatch 14 -> 0`,
`unresolved quarantine 12 -> 0`, and exactly 14 new P3 cache-outbox events.
Production matched that result.

The first local outbox drain failed safely because the operator `.env` points
`APP_BASE_URL` at `localhost:3000`; the 14 events returned to `pending`
with attempt count 1 and zero dead letters. An unauthenticated network probe
confirmed the production endpoint at `worldcons.vercel.app` was reachable
(401 without credentials), so the maintenance invocation overrode only
`APP_BASE_URL` for that run. The existing bounded outbox processor then
completed in one pass: **14 claimed / 14 delivered / 0 failed / 0 dead-letter**.

### Lifecycle backlog

The five remaining `lifecycle.review` rows were not failed crawls. All five
were Spain HJ records with:

- `status=metadata_only`;
- verified official source URL;
- `sourceTextAvailable=false`, `publishable=false`;
- `sourceTextStatus=not_available`;
- no error class and no human-review requirement;
- official HJ metadata explicitly indicating that the resolution contains no
  constitutional doctrine and source text is intentionally unavailable.

Treating those rows as retryable `collection.metadata_only` attention was a
state-model bug. The forward-fix leaves collection/processing/review/publication
semantics unchanged and clears only that retry attention when the general,
machine-verifiable terminal metadata-only predicate is met. The TypeScript
legacy mapper now uses the same rule so future rows do not recreate the backlog.
The migration is bounded to at most 100 matching rows and fails closed on scope
expansion.

The production `ROLLBACK` rehearsal predicted `lifecycle backlog 5 -> 0`;
the applied migration produced the same result.

### Final production gate

Final read-back after both migrations and the outbox drain:

| Signal | Final |
| --- | ---: |
| legacy public | 1272 |
| P3 public projection | 1272 |
| publication parity mismatch | **0** |
| unresolved publication quarantine | **0** |
| lifecycle review/attention backlog | **0** |
| P3 outbox pending / processing / dead-letter | **0 / 0 / 0** |
| in-flight admin commands / legacy jobs | **0 / 0** |

`ADMIN_P5_HEALTH_VERIFICATION_ENABLED=true pnpm admin:health:p5 -- --window-hours=336`
now exits 0 with:

```json
{"schemaVersion":1,"status":"passing","hardViolationKeys":[],"outputWritten":false}
```

`wrangler versions view 510507c0-de82-4019-a1dd-d2a1f8f37cf4 --json`
reconfirmed the deployed resting bindings:
`M8_SCHEDULER_ENABLED=false` and `M8_ENABLED_KINDS=admin-health`.

**GO-ASYNC acceptance is therefore recorded.** The one remaining evidence
limitation is unchanged: Cloudflare's read-only API cannot expose the body of a
push-consumer DLQ message, so the injected `m8:invalid:gate-probe` cannot be
body-attributed to one specific observed DLQ write. The automatic retry→DLQ
path itself remains evidenced by queue backlog deltas and matching
`DeleteMessage(outcome=dlq)` / DLQ `WriteMessage` events. This limitation
does not justify weakening the queue or switching it to pull mode solely for
inspection.

Recording GO-ASYNC does **not** flip the scheduler. The resting deployment
remains disabled; scheduler activation is a separate post-checkpoint action.


## 1. Scope completed in this step

- Re-ran and repaired the full M8 verification set (see section 5).
- Confirmed every legacy scheduled path is retired in this branch (section 4).
- Authored this completion/status record and updated the full migration
  roadmap/checklist with the exact deployed resources, safety state, live
  evidence, limitations and post-commit/post-main sequence.

### Implementation and tooling edits made during this step

The 2026-09-26 follow-up **does change M8 runtime behavior**: it adds the
per-kind rollout gate at scheduled, Queue and Workflow entry points, fixes the
Cloudflare Workflow instance-id encoding, and adds the bounded canary operator.
The following two earlier edits are tooling-scope only:

1. `eslint.config.mjs` — ignore generated `**/worker-configuration.d.ts`. These
   Wrangler-generated ambient files produced 4 unfixable "unused eslint-disable
   directive" warnings; `pnpm lint` now exits 0 with no output.
2. `tsconfig.json` — the root program previously included
   `workers/async-pipeline/**` and `workers/browser-run/**` sources while
   excluding their generated ambient types, so `pnpm typecheck` failed with
   missing `Env`/`cloudflare:workers`/`ExportedHandler` names. The two Worker
   source directories are now excluded from the root program (each has its own
   `tsconfig.json` used by `pnpm m8:typecheck`). `pnpm typecheck` and
   `pnpm m8:typecheck` both pass.

## 2. Exact deployed resources (as reported by the operator/context)

The initial resource facts were supplied by the interrupted Codex run. This
follow-up then queried the deployed state, performed the bounded admin-health
canary, and redeployed `worldcons-ingest` first for the canary and then back to
the disabled resting state. No publication/search authority or application data
was changed by the canary.

### worldcons-ingest (async control plane)

- Worker name: `worldcons-ingest`
- Final resting deployed version: `510507c0-de82-4019-a1dd-d2a1f8f37cf4`
- Earlier version (first completion record): `8988532e-2feb-4675-8b76-52fd54508e30`
- Bindings present: Cron triggers, Queue producer/consumer, Workflow
- `M8_SCHEDULER_ENABLED`: `false` (safety state)
- `M8_ENABLED_KINDS`: `admin-health` (canary-only, inert while disabled)
- Secrets required: `GITHUB_ACTIONS_TOKEN` (set)
- Queues that exist:
  - `worldcons-async-v1` (main)
  - `worldcons-async-dlq-v1` (dead-letter queue)

### worldcons-browser-run (browser transport)

- Worker name: `worldcons-browser-run`
- Deployed version: `f324efe7-9912-4b22-8c94-74aab2a3fc6f`
- Secret required: `BROWSER_RUN_TOKEN` (set)
- Browser Run binding: `BROWSER`
- Allowed hosts var: German, US, French and Spanish constitutional-court hosts.

### GitHub Actions configuration

- Cloudflare Browser Run token: set
- GitHub Browser Run token: set
- Cloudflare `GITHUB_ACTIONS_TOKEN`: set
- GitHub Actions variable `CLOUDFLARE_BROWSER_RUN_URL`: set

## 3. Live Browser Run evidence already obtained

A real Supreme Court discovery through the deployed Browser Run transport was
reported to return:

- HTTP/navigation status: `200`
- HTML content length: `127875` characters

This is live remote evidence that the Browser Run Worker navigates a real
constitutional-court target and returns substantial rendered HTML. It is **not**
a full crawler pipeline or search-parity result. No scheduler-enabled execution
was involved.

## 4. Legacy schedule retirement (verified in this branch)

All six operational GitHub workflows had their `schedule:` triggers removed and
retain `workflow_dispatch` plus a new optional `m8_idempotency_key` input; the
Vercel cron list was removed:

| Path | Before | After |
| --- | --- | --- |
| `.github/workflows/admin-job-worker.yml` | `*/15 * * * *` | dispatch + M8 identity |
| `.github/workflows/admin-watchdog.yml` | `*/15 * * * *` | dispatch + M8 identity |
| `.github/workflows/crawlee-worker.yml` | `0 0 * * *` | dispatch + M8 identity |
| `.github/workflows/embedding-backfill.yml` | `30 1 * * *` | dispatch + M8 identity |
| `.github/workflows/summary-drain.yml` | `30 3,9,15,21 * * *` | dispatch + M8 identity |
| `.github/workflows/admin-health-p5.yml` | `17 20 * * *` | dispatch + M8 identity |
| `vercel.json` | two `/api/ops/watchdog` crons | `crons` key removed |

Verified directly in this step:

- `rg "cron:" .github/workflows vercel.json` returns no matches.
- `vercel.json` parses with no `crons` key.
- `M8_CRON_EXPRESSIONS` in `lib/cloudflare/async-pipeline/contracts.ts` matches
  the five retired expressions exactly.
- `admin-command-worker-p1.yml`, `release-gate.yml` and `bverfg-diagnose.yml`
  were never scheduled and keep their existing triggers.

Manual `workflow_dispatch` execution is retained so GitHub Actions stays the
long-running Node compatibility executor when orchestrated by M8.

## 5. Verification results for this step

| Command | Result |
| --- | --- |
| `pnpm test:m8` | 23/23 pass (including M8 P5 forward-fix contracts) |
| `pnpm m8:types:check` | both Workers "up to date" |
| `pnpm m8:typecheck` | both Worker tsconfigs pass |
| `pnpm lint` | exit 0, no warnings |
| `pnpm m8:dry-run` | both Workers bundle and bind correctly |
| `pnpm typecheck` (root) | pass |
| `pnpm test:p1` | 23 tests: 22 pass, 1 PostgreSQL integration skip, 0 fail |
| `pnpm test:p2` | 16 tests: 15 pass, 1 PostgreSQL integration skip, 0 fail |
| `pnpm test:p3` | 9 tests: 8 pass, 1 PostgreSQL integration skip, 0 fail |
| `pnpm test:p5` | 21 tests: 20 pass, 1 PostgreSQL integration skip, 0 fail |
| `pnpm test:embeddings` | 10/10 pass |
| `git diff --check` | clean |

New `test:m8` coverage: `M8_ENABLED_KINDS` parser fail-closed matrix, disabled
vs. enabled allowlist gate, per-kind `scheduled()` eligibility, Queue
ack/retry/dispatch partition, workflow-instance-id validity/length and
collision-safety across all kinds, GitHub input preserving the original
colon-form key, and the operator canary report staying off GitHub and refusing
disabled kinds.

Dry-run bindings observed:

- `worldcons-ingest`: `ASYNC_WORKFLOW` (Workflow), `ASYNC_QUEUE`
  (`worldcons-async-v1`), `M8_SCHEDULER_ENABLED ("false")`,
  `GITHUB_REPOSITORY ("kjw2/worldcons")`, `GITHUB_REF ("main")`; upload
  10.68 KiB.
- `worldcons-browser-run`: `BROWSER` (Browser Run),
  `BROWSER_ALLOWED_HOSTS`; upload 3088.66 KiB.

## 6. Design summary

### Cron → Queue → Workflow → GitHub executor

1. `scheduled()` maps a Cron expression to deterministic `M8TaskMessage`s
   (`lib/cloudflare/async-pipeline/contracts.ts`).
2. Messages are enqueued to `worldcons-async-v1`.
3. The queue consumer validates each message and creates a `Workflow` instance
   whose id is the Cloudflare-safe deterministic encoding returned by
   `workflowInstanceId()` (for example
   `m8-admin-health-2026-09-26T09-00-00-000Z`), while preserving the original
   colon-form idempotency key for the GitHub executor.
4. The Workflow's `dispatch-compatible-executor` step dispatches the mapped
   GitHub Actions workflow with `m8_idempotency_key` as an input.

Idempotency is layered:

- queue replay yields the same sanitized Workflow instance id for the same
  `m8:<kind>:<minute>` identity, and `planM8QueueBatch()` collapses an inbound
  batch to one create per identity so a redelivery cannot schedule a second
  Workflow;
- `Workflow.run()` re-checks the kind before dispatching, so a re-entered
  Workflow for an already-dispatched identity cannot produce a second GitHub
  side effect;
- `scripts/admin-command-worker-p1.ts` derives its P1 command identity from
  `M8_IDEMPOTENCY_KEY` when present (`resolveP1InvocationIdentity` ->
  `p1CommandIdentities`), falling back to the run id/attempt only when it is
  absent, and fails closed on a blank identity.

### Safe-disable behavior

- `scheduled()` logs `m8_schedule_skipped` and returns (also when the allowlist is
  invalid or no kind is allowed).
- `queue()` acks schema-valid but gate-blocked messages without dispatch, and
  retries only malformed payloads (bounded) toward the DLQ.
- `Workflow.run()` returns `{ dispatched: false }` when the kind is not enabled.

No live GitHub dispatch can occur while `M8_SCHEDULER_ENABLED=false`, and only
allowlisted kinds can dispatch while it is `true`.

### Browser Run transport

`lib/crawler/cloudflare-browser-run-client.ts` posts to the Browser Run Worker
`/v1/navigate` endpoint over HTTPS with bearer auth, bounds timeout/size, and
maps the response to `CrawlResponse`. Both the Playwright client and the Crawlee
Playwright pass prefer Browser Run when
`CLOUDFLARE_BROWSER_RUN_URL`/`CLOUDFLARE_BROWSER_RUN_TOKEN` are set, and fail
closed when `CLOUDFLARE_BROWSER_RUN_REQUIRED=true` but unconfigured.

## 7. Current limitations

1. **GitHub Actions remains the executor.** M8 orchestrates; it does not yet
   execute long-running Node/Crawlee/Playwright jobs on Cloudflare.
2. **Full Cloudflare execution would require Containers.** Rewriting Crawlee and
   heavy extraction into Workers/Browser Run is not done. This is a later task
   (section 9), not silently implemented here.
3. **Scheduler disabled at rest by design.** One live Queue → Workflow → GitHub
   `workflow_dispatch` was exercised end-to-end during the controlled
   admin-health-only rehearsal (`36232371374`), and replay deduplicated. P5
   health now passes and GO-ASYNC acceptance is recorded, but activation remains
   a separate deliberate step after the checkpoint is on the intended branch.
4. **P5 data gate is resolved.** The 2026-09-27 final health check reports
   `hardViolationKeys=[]`; publication parity, unresolved quarantine, lifecycle
   backlog and P3 outbox backlog are all zero.
5. **Browser Run evidence is one navigation.** It proves the transport works
   against a real target; it is not a per-source crawler-parity result.
6. **Request-governor parity is now enforced and unit-proven** (Browser Run
   permit + `fetchRawItem` propagation), but no governed live crawler run was
   executed in this task.
7. **Restart/recovery and no-duplicate-publication invariants are now
   unit-proven** for the Queue -> Workflow boundary. Automatic DLQ transition
   activity is observed under the unchanged retry policy, but the injected
   `m8:invalid:gate-probe` cannot be attributed by body through the read-only
   Cloudflare API, so that specific item is `OBSERVED_ACTIVITY_UNATTRIBUTED_OPEN`
   rather than fully proven.

These limitations do not block M8 orchestration acceptance. `GO-ASYNC` is
recorded with the DLQ body-attribution observability limitation explicitly
preserved; full Cloudflare-native execution/Containers remains a later milestone.

## 8. Post-commit / post-main sequence

After this branch is reviewed and checkpointed by the workflow/controller, and
only after the changes reach `main`:

1. Confirm the deployed `worldcons-ingest`/`worldcons-browser-run` versions
   match the merged config (resting `worldcons-ingest` should be
   `510507c0-de82-4019-a1dd-d2a1f8f37cf4` with
   `M8_SCHEDULER_ENABLED=false` and `M8_ENABLED_KINDS=admin-health`).
2. Keep `M8_SCHEDULER_ENABLED=false` during any further activation rehearsal; the
   admin-health canary gate is already proven but the resting state must stay
   disabled.
3. P5 health blockers are now clear and GO-ASYNC acceptance is recorded. For
   any activation, enable one low-risk kind at a time via
   `M8_ENABLED_KINDS` (e.g. exactly `admin-health`), never `*`, and confirm
   dispatch idempotency with `pnpm m8:canary`.
4. Flip `M8_SCHEDULER_ENABLED=true` only on explicit authorization, then observe
   queue backlog, DLQ depth, Workflow success and GitHub run identity for the
   allowlisted kind only.
5. Preserve the documented DLQ body-attribution limitation; do not switch the
   production push consumer to pull mode merely to inspect one message body.
6. Retire the remaining manual fallbacks only after an explicitly authorized
   activation has remained stable under live observability.

None of steps 2–6 is performed by this document.

## 9. Later task — full Cloudflare execution (Containers)

If the plan requires removing the GitHub Actions compatibility executor, the
remaining work is a Containers-backed crawler job runner (or a per-source
Browser Run + Worker rewrite) plus memory/CPU benchmarking for jsdom/pdf-parse.
That is a separate milestone and must not be started implicitly.

## 10. Related documents

- `docs/worldcons-cloudflare-full-migration-plan-20260920.md` (M8 section and
  checklist updated with this status)
- `docs/worldcons-cloudflare-m7.9-go-search-readiness-20260926.md`
