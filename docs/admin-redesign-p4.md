# Administrator Redesign P4 Runbook

Status: production UI cutover complete; redesigned administrator shell is the only supported interface

## Scope And Authority

P4 provides the permanent `AdminShell`, operational overview, unified work queue, safe work detail, canonical P0/P1/P3 actions, and operator acceptance documentation. Existing article review/edit/resummary behavior, immutable source snapshots, compatibility APIs, and public routes remain present. The V2 tab strip, operations screen, and job queue screen were removed on 2026-07-13.

P4 does not change worker authority, public read authority, P2 lifecycle authority, P3 publication eligibility, outbox authority, or production data. Queue completion still cannot publish. Lifecycle completion still cannot publish. P5 governance, retention, and compatibility retirement are outside this stage.

## Operator Task Map

| Operator intent | Start route | Filter or next route | Authority |
| --- | --- | --- | --- |
| See current operational pressure | `/admin` | BPM lanes and attention metrics link to `/admin/work` | Read only |
| Triage SLA breaches | `/admin/work?attention=required&sla=breached&sort=sla` | Open a work detail | Read only |
| Inspect a command lease/fence | `/admin/work?type=execution` | `/admin/work/execution/[runId]` | P0 read |
| Abort active V3 work | Execution detail/row | `Request abort`, with reason | P0 `admin_abort_command_run_v3` |
| Retry failed/aborted V3 work | Execution detail/row | `Retry`, with reason and idempotency key | P0 `admin_retry_command_run_v3` |
| Requeue a URL candidate | `/admin/work?type=candidate` | `Requeue`, with reason and idempotency key | P0 submit of P1 `p1.candidate.retry` |
| Review or edit an article | Article work detail | `/admin/articles/[slug]` | Existing article APIs |
| Publish an eligible reviewed version | Article detail/row | `Publish`, confirmation and reason required | P3 publication authority |
| Withdraw a published version | Article detail/row | `Withdraw`, confirmation and reason required | P3 publication authority |
| Inspect publication/version/audit/outbox history | `/admin/work/article/[articleId]` | Related article and audit links | P2/P3 read only |
| Inspect compatibility jobs | `/admin/work?type=legacy` | Unified work detail | Compatibility read |
| Inspect candidate raw URL | `/admin/candidates` | Existing protected specialist page | Existing candidate API |

Review assignment/claim/release is unavailable because P2 has no accepted ownership contract. Manual outbox retry/dead-letter is unavailable because P3 exposes only leased processor transitions. P4 renders an accessible disabled explanation and never writes those states directly.

## Route And Information Architecture

| Area | Route | Notes |
| --- | --- | --- |
| Operations overview | `/admin` | First screen; collect -> process/summarize -> review -> publish |
| Unified queue | `/admin/work` | URL-shareable owner/stage/source/type/state/attention/SLA/age/sort/page filters |
| Unified queue API | `/api/admin/work` | Authenticated GET using the same bounded parser and snapshot repository |
| Work detail | `/admin/work/[type]/[id]` | Safe timeline; no payload, raw/source URL, source text, summary content, or secrets |
| Article management | `/admin/articles`, `/admin/articles/[slug]` | Existing deep links and critical actions preserved |
| Candidate management | `/admin/candidates` | Existing protected raw-URL workflow preserved |
| Runs and compatibility jobs | `/admin/ingestion-runs`, `/admin/work?type=legacy` | Execution history and compatibility work remain visible in the new UI |
| Audit/configuration | `/admin/audit`, `/admin/llm`, `/admin/analytics`, `/admin/glossary-candidates` | Reachable under the shell |

`/admin/operations` permanently redirects to `/admin`; `/admin/jobs` permanently redirects to `/admin/work?type=execution`. Login remains outside the authenticated shell.

## Work Queue Contract

The server reads a bounded maximum of 500 rows per domain and issues at most nine queue-page queries. Attempts are fetched once for all displayed P0 runs. No query is issued from a row render or row loop. Sort order always ends with `type` and stable record ID. Page is bounded to 1-20 and page size to 10-50. A bounded/truncated notice asks operators to narrow filters rather than implying a complete unbounded result.

The domains are:

1. P0 command/run/latest attempt execution.
2. P2 article lifecycle and P3 publication state.
3. URL candidates, with no URL selected by the queue repository.
4. P3 cache outbox, with identifiers and bounded error codes only.
5. Explicitly labelled V2 `admin_jobs` compatibility fallback.

If service-role access or any P0-P3 table is unavailable, the page remains safe: the unavailable domain is empty, a compatibility notice is shown, and retained routes remain usable. Default-off V2 pages do not query P0-P3.

## State Label Dictionary

Every row has three independent labels. `not linked` means the domain has no safe relationship or its accepted schema is unavailable; it never means success.

| Label | Source | Examples | Must not imply |
| --- | --- | --- | --- |
| Execution | P0 run/attempt or V2 job | `queued`, `running`, `retry_wait`, `succeeded`, `failed`, `aborted`, `lease_expired`, `shadowed` | Article readiness or publication |
| Article lifecycle | P2 axes or bounded candidate state | `source_text_ready / complete / approved`, `needs_review`, `failed` | Public visibility |
| Publication | P3 current publication | `draft`, `in_review`, `published`, `withdrawn` | Worker success or lifecycle completion |

Attention is independent from all three labels. It carries a bounded code and SLA treatment. Red indicates a failed, aborted, expired, dead-letter, active, or anomaly state; amber indicates queued/retry/review/pending/withdrawn attention; teal indicates successful/complete/published/delivered; navy indicates active processing. Color is never the only signal.

## Role And Action Matrix

The current authentication contract has one administrator role backed by the signed administrator session. Cron secret callers remain supported by existing compatibility routes but are not an interactive P4 role.

| Action | Interactive admin | Cron secret | Server revalidation | Confirmation/reason |
| --- | --- | --- | --- | --- |
| Read shell/queue/detail | Allowed | Existing read APIs only | Signed session page check | None |
| Abort V3 run | Allowed | API authentication contract permits secret, but UI is session only | P0 run state/fence authority | Reason required |
| Retry V3 run | Allowed | Same API boundary | P0 terminal state and active dedupe | Reason and explicit idempotency key |
| Candidate requeue | Allowed | Same API boundary | Candidate must still be `pending` or `failed`; P0 dedupe | Reason and explicit idempotency key |
| Publish | Allowed | Same API boundary | P3 state must be `in_review` or `withdrawn`; P3 rechecks eligibility and revisions | `publish` confirmation, reason, idempotency key |
| Withdraw | Allowed | Same API boundary | P3 state must still be `published`; revisions must match | `withdraw` confirmation, reason, idempotency key |
| Assign/claim/release review | Not supported | Not supported | No accepted P2 ownership authority | Disabled explanation |
| Retry/dead-letter outbox manually | Not supported | Use accepted processor only | No accepted P3 manual authority | Disabled explanation |

All new mutations pass `adminMutationAuthFailureStatus`: signed sessions require same-origin headers and a session-bound CSRF token; unauthenticated requests return 401 and failed origin/CSRF checks return 403. The action route never accepts actor identity from the browser.

## Privacy And Redaction

Queue/detail selects omit command `payload_ref`, command/result summaries, candidate URLs, article original/canonical URLs, raw/cleaned text, summary JSON, audit safe metadata, and version content fields. Operational errors pass existing audit redaction and replace any remaining absolute URL with `[redacted-url]`. Timeline events contain only IDs, bounded state/event names, actor fields, bounded reasons/error codes, times, and correlation/request IDs.

Use the retained protected candidate/article pages when raw operational evidence is required. Do not add that evidence to P4 rows, browser logs, screenshots, support tickets, or audit summaries.

## Production Cutover And Rollback

The administrator UI no longer has a V2 fallback flag. Rollback uses a reviewed deployment rollback or forward fix; it must not restore the removed tab strip or retired screens. Queue, lifecycle, publication, and observation authority flags remain independently reversible without changing the administrator interface.

## Support Triage

| Signal | First check | Next route/runbook | Escalate when |
| --- | --- | --- | --- |
| Empty queue with compatibility notice | Service-role config and named unavailable domain | `/admin/work?type=legacy`, `/admin/articles`, `/admin/candidates` | Expected P0-P3 schema should be available |
| Abort conflict | Reopen execution detail and inspect terminal state/event | P0 abort SLA section | Active run remains nonterminal past SLA |
| Retry conflict | Check active duplicate and latest run | P0/P1 runbook | No active duplicate exists but retry remains blocked |
| Publish conflict | Check all three labels and latest publication revision | P2/P3 runbooks | UI and P3 authority disagree after refresh |
| Withdraw conflict | Confirm current publication state | P3 history/audit | A published revision cannot be withdrawn after refresh |
| Outbox breach/dead letter | Inspect bounded outbox state/error code | P3 outbox processor runbook | Dead-letter count is nonzero or oldest pending exceeds SLO |
| Article edit/regression | Use retained article detail and source snapshot | Existing article review API | Immutable snapshot or edit history differs |
| Horizontal/mobile overflow | Record route, viewport, and non-sensitive screenshot | P4 accessibility acceptance | Text/actions overlap or page viewport scrolls horizontally |

## Accessibility Acceptance

- Shell has a visible-on-focus skip link and `#admin-main` focus target.
- Current location uses `aria-current=page`; mobile navigation is a labelled modal and closes with Escape.
- All icon-only controls have accessible names and native tooltips.
- Disabled actions include a readable reason in visible text or screen-reader text.
- State meaning is present in text; color is supplemental.
- Desktop queue uses a captioned semantic table; mobile uses articles with definition lists.
- Loading uses `role=status`; fatal read failure uses `role=alert`; empty state provides recovery.
- Focus indicators remain visible on every link, field, button, drawer control, and action.
- At 1440px, shell, filters, table scroll region, and detail timeline do not cause viewport overflow.
- At approximately 390px, the shell drawer, filters, compact list, actions, and timeline fit without overlap or clipped text.
- No viewport-width font scaling or negative letter spacing is used; shell letter spacing is explicitly zero.
- Reduced-motion users retain usable loading and navigation behavior.

## Gate 4 Checklist

- [ ] Flag absent/false shows V2 parity on every retained route.
- [ ] Flag true shows shell navigation, identity/session control, current location, and deep links.
- [ ] Unauthenticated overview, queue, and detail redirect to login with safe `next`.
- [ ] Every action returns 401 without auth and 403 for invalid origin/CSRF.
- [ ] Filter values, page, and page size reject or clamp malformed/oversized input.
- [ ] Pagination/sort are deterministic and query state is shareable.
- [ ] Execution, lifecycle, and publication labels remain independently correct.
- [ ] Payloads, URLs, source text, content, provider output, and secrets are absent from queue/detail output.
- [ ] Stale lease, abort, retry, publish, and withdraw conflicts refresh safely and never force state.
- [ ] Query count stays within the documented budget with zero per-row reads.
- [ ] Loading, empty, compatibility, bounded-result, and error states are accepted.
- [ ] Article detail/edit/resummary/retranslation and immutable snapshot workflows regress cleanly.
- [ ] Keyboard-only and screen-reader smoke passes.
- [ ] 1440px and approximately 390px screenshots pass; no page-level horizontal overflow or overlap.
- [ ] Browser console has no errors on overview, queue, detail, and representative specialist pages.
- [ ] `pnpm test:p0`, `test:p1`, `test:p2`, `test:p3`, `test:p4`, `tsc`, `lint`, `check`, `build`, and `git diff --check` pass.
- [ ] Rollback to flag false is rehearsed without data deletion.
- [ ] Gate 4 owner records approval. P5 does not start automatically.
