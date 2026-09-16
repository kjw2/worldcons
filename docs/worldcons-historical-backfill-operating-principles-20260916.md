# WorldCons historical backfill operating principles

Date: 2026-09-16
Status: canonical operating policy for historical constitutional-case backfill

## 1. Core principle: acquisition first, AI/publication later

Historical backfill and Gemini-powered enrichment/publication are two different pipelines and must never be conflated.

The historical backfill pipeline exists to acquire and preserve the authoritative corpus as quickly and completely as official-source and policy constraints allow:

1. authoritative inventory/discovery;
2. source fetch;
3. normalization;
4. verification;
5. reconciliation;
6. immutable provenance/snapshot closure.

Gemini quota, translation capacity, Korean summarization capacity, embedding capacity, and public-release throughput **must not throttle, delay, or redefine historical corpus acquisition**.

If Gemini quota is exhausted, historical fetch/normalize/verify continues. No acquisition milestone may be marked blocked merely because AI enrichment or public release is waiting.

## 2. Two independent completion axes

Every country/year/type tranche reports two separate states.

### A. Corpus backfill state

`corpus_backfill_complete` means the authoritative tranche has been inventoried, fetched, normalized, verified, reconciled, and sealed with durable provenance. This is the completion criterion for the historical collection job itself.

### B. Enrichment/publication state

`public_enrichment_complete` means the acquired tranche has additionally passed the configured translation/summary/enrichment workflow and the intended public Catalog/P3 publication path.

These states must never be collapsed into one ambiguous word such as `complete` without a qualifier.

A tranche may therefore legitimately be:

- corpus backfill complete / enrichment pending;
- corpus backfill complete / partially enriched or published;
- corpus backfill complete / public enrichment complete.

## 3. Gemini quota policy

Gemini is a downstream enrichment resource, not a prerequisite for historical acquisition.

- No Gemini call is required for inventory, fetch, normalize, verify, reconcile, or snapshot closure.
- Gemini work is paced by available quota and may run gradually after the source corpus has already been secured.
- A temporary or long-running Gemini quota shortage must increase the enrichment backlog, not stop the crawler/backfill frontier.
- Source text and authoritative metadata must remain durably available while waiting for AI processing.
- Gemini failures never justify discarding, re-fetching, or reopening an otherwise valid sealed source snapshot.

## 4. Publication policy

Public release is downstream from corpus acquisition and may progress more slowly than fetch because enrichment capacity is intentionally bounded.

For every completed corpus tranche, operations must maintain an explicit accounting of:

- acquired/verified item count;
- AI enrichment pending count;
- enrichment completed count;
- public publication pending count;
- public publication completed count;
- excluded/duplicate/withdrawn count with reason.

The absence of public publication does not invalidate an acquired corpus, but it must remain visible as a tracked downstream backlog rather than being mistaken for lost work.

## 5. Country execution order

All four constitutional-case programs continue under this same rule. Current operational priority is based on source readiness, not on Gemini capacity.

1. **France** — current leading historical program. Continue newest-to-oldest QPC/DC acquisition from the current 2022 frontier to 2021 and earlier, one bounded tranche at a time.
2. **Germany** — preserve the completed 2024 replacement canary, then expand to 2023 and earlier only after the required multi-year source-policy approval is recorded.
3. **United States** — the Constitution Annotated candidate graph is only a discovery aid, not the verified SCOTUS corpus. Build the official-source candidate/authority corpus independently of Gemini, then enrich/publicize verified cases downstream.
4. **Spain** — do not bypass the existing legal/robots source-policy block. Once approved, acquire the 2024 baseline then historical SENTENCIA tranches; Gemini/publication remains downstream.

This priority does not mean countries 2–4 wait for France AI enrichment. Independent source-policy and crawler work may proceed in parallel. Only source-policy, authority, robots/legal, correctness, and operational-safety gates may block corpus acquisition.

## 6. Reporting requirements

Every milestone report must separately state:

- **Corpus acquisition:** inventory/fetch/normalize/verify/reconcile status and counts.
- **AI enrichment:** pending/completed counts and current quota-limited throughput if applicable.
- **Publication:** pending/published counts and public-read state.
- **Next corpus frontier:** the next country/year/type that can be acquired without waiting for AI.

When a report says “backfill complete” without qualification, it means **corpus backfill complete**, not “all Gemini enrichment and publication complete.” If public completion is intended, the report must explicitly say `public_enrichment_complete` or “공개·AI 후처리까지 완료”.

## 7. Non-regression rule

Future plans, runbooks, code reviews, and agent instructions must preserve this separation. A proposal that makes historical fetch contingent on Gemini quota or completion of prior AI/publication backlog is a regression and must be rejected unless the owner explicitly changes this operating policy.
