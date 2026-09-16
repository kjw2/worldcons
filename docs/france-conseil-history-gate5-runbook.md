# France Conseil constitutionnel QPC/DC Gate 5 runbook

## Scope and safety state

This stage supports one immutable snapshot per calendar year and decision facet for Conseil constitutionnel decisions from 2010 through 2024. Gate 5 owns only pre-2025 years; 2025 and later are handled by the incremental ingestion workflow, not this historical ledger.

- source: `fr-conseil-constitutionnel`
- document types: `QPC` and `DC` only
- primary inventory: the latest official DILA `CONSTIT` global stock plus every later official ordered `CONSTIT_*.tar.gz` increment, overlaid by DILA ID and then filtered by exact `NATURE` and decision year
- independent count cross-check: the official Conseil annual/type result pages
- authority detail: `https://www.conseil-constitutionnel.fr/decision/{year}/{record}.htm`
- coverage: `authoritative_crosschecked` only when the final DILA stock+ordered-increment identity set/count, official active-type facet identity set/count, and unique manifest count all match
- public Catalog and Gemini: not enabled by this stage

QPC and DC use separate snapshots. QPC360 results from Conseil d'État, Cour de cassation, and other courts are outside this first France scope. QPC360 is not part of the primary manifest until its export terms and stable automated contract are reviewed in a versioned source policy.

The source-policy evidence and proposed immutable row are in [france-constit-source-policy-review-20260903.md](./france-constit-source-policy-review-20260903.md). On 2026-09-16 the WorldCons owner approved that policy for the 2010-2024 `QPC`/`DC` tranches only. Migration `20260916090000_constitutional_case_france_policy_approval.sql` inserts the immutable policy row `fr-conseil-constitutionnel` / `france-dila-constit-2026-09-v1` (review due `2027-03-15`). Spain and the Germany 1998-2023 expansion are not approved by this decision.

## Fail-closed rules

Discovery stops without closing the manifest when any of these conditions occurs:

1. `CASE_CATALOG_FRANCE_HISTORY_ENABLED` is not exactly `true`.
2. The exact approved policy must be present and current. `FRANCE_CONSEIL_HISTORY_SOURCE_POLICY_STATUS` is `approved_source_policy`, `FRANCE_CONSEIL_HISTORY_SOURCE_POLICY_APPROVED` is `true`, and the approved policy is `france-dila-constit-2026-09-v1`. The history flag is still required, so flag-off fails with `case_backfill.france_history_disabled` before any run row is created. An explicitly unapproved policy state still fails with `case_backfill.france_history_source_policy_not_approved`. The CLI `plan` report exposes `sourcePolicyStatus` and `sourcePolicyApproved`.
3. The year is before 2010 or after 2024. Gate 5 historical scope is limited to pre-2025; 2025 and later are owned by the incremental ingestion workflow.
4. The document type is not QPC or DC. `L`/`LP`/`OTHER_CONSEIL_NATURE` remain deferred to a later policy version and fail with `case_backfill.france_history_source_policy_not_approved` even when the history flag is on.
5. the DILA directory, stock, or increment request violates the reviewed host, redirect, byte, archive, lease, or fencing contract.
6. latest-stock selection or ordered increment selection is ambiguous, an archive/XML structure is malformed, or the bounded increment limit is exceeded.
7. the active official facet count is missing or changes during pagination.
8. pagination does not exhaust within the configured bound.
9. two distinct effective DILA IDs map to the same Conseil decision identity. DILA ID is the approved stable inventory identity, so discovery must not choose a winner automatically.
10. the exact overlaid DILA identity set/count, unique manifest count, and official Conseil facet identity set/count differ.

Sitemap `lastmod` values are update metadata and never become decision dates. Dates come from the official decision title/detail and must remain within the snapshot year.

## Planning without writes

```bash
pnpm backfill:corpus plan --source=france --year=2024 --document-type=QPC
pnpm backfill:corpus plan --source=france --year=2024 --document-type=DC
```

Both plans report `executionEnabled: false` under the default environment.

The combined DILA stock and Conseil identity-set contract can be checked without database writes:

```bash
pnpm verify:france-inventory --year=2024 --document-type=QPC
```

This read-only probe obeys robots policy, request delay, timeout, bounded response and archive limits, exact `NATURE` filtering, bounded pagination, and identity-set reconciliation. M5-B2.2 now applies the approved ordered increment overlay after the base stock. On 2026-09-16 the directory exposed 21 post-stock increments after `Freemium_constit_global_20250713-140000.tar.gz`; read-only revalidation still produced exact 2024 QPC 42/42, 2024 DC 12/12, 2023 QPC 45/45, and 2023 DC 15/15 identity sets.

The parser rejects malformed timestamps, cross-origin or redirecting stock URLs, oversized compressed/expanded/member data, path traversal, duplicate paths or identities, links and other non-regular tar members, invalid tar checksums/terminators, non-UTF-8 XML, DTD/entity declarations, wrong origin/jurisdiction, invalid dates, and non-Conseil authority URLs.

## Immutable item provenance contract

Migration `20260903182000_constitutional_case_inventory_provenance.sql` makes the official evidence part of each inventory item and of the closed manifest hash. France items must carry:

- DILA ID, exact `NATURE`, ECLI (including an explicit null), decision number, qualified nature, and the bound XML member path;
- base-stock filename, long DILA URL, extraction timestamp, `Last-Modified`, ETag, compressed content length, and SHA-256;
- when the effective representation was supplied by a later increment, that increment's filename, URL, timestamp, response provenance, SHA-256, and ordered application position;
- full base-stock/increment archive provenance is stored as append-only enumeration artifacts and sealed through `enumeration_manifest_hash`; the 16 KiB snapshot `coverage_evidence` remains a compact count/first/last/chain-hash summary rather than duplicating the complete archive list;
- Open Licence 2.0 identifier/URL and `DILA` attribution.

The payload is a bounded JSON object, recursively screened for credential-like keys and common secret values. France-specific identity, URL, archive path, stock, hash, and licence shapes are checked in the database. Once the snapshot closes, item provenance cannot be updated, and changing only the stock hash changes the manifest hash.

The worker uses the v2 upsert, close, and claim RPCs. Production `service_role` execution is revoked from the corresponding v1 RPCs, preventing an application path from omitting the new provenance field or closing a legacy hash. The provenance is copied into `metadata.sourceInventory` for bounded fetch replay and normalization, so the Catalog source revision receives the same immutable evidence. Direct table writes remain unavailable to the worker.

## Private-shadow execution prerequisites and rollout status

The owner approved the review document on 2026-09-16, chose the reviewer `WorldCons owner via explicit approval`, a 90-day bounded retention, and a `review_due_at` of `2027-03-15`, and recorded the resulting immutable `source_corpus_policies` row in migration `20260916090000_constitutional_case_france_policy_approval.sql`. That migration is now applied to the production `worldcons` Supabase project. The policy covers the DILA directory/stock, Conseil count/detail cross-checks, robots observations, attribution, AI egress denial for the source-only canary, bounded replay fields (including `metadata`), request delay, concurrency, retention, and `review_due_at`.

The 2024 QPC/DC private-shadow canary completed successfully on 2026-09-16. QPC snapshot `473522ae-2b03-4581-8ba7-7632a8e41048` sealed 42/42 items and DC snapshot `bc1ebccd-8cbc-4821-babe-5fe850925875` sealed 12/12 items. All 54 items reached fetched + normalized + verified state, with zero item errors, zero active claims, and zero Catalog publications. See [worldcons-m5b2-france-2024-private-shadow-canary-20260916.md](./worldcons-m5b2-france-2024-private-shadow-canary-20260916.md).

The canary also exposed and repaired a pre-write schema mismatch: authoritative crosschecked snapshots need to learn the official expected count during discovery. Migration `20260916093000_constitutional_case_open_authoritative_count.sql` now permits a null count only while such a snapshot is `open`/`failed`; successful `closed`/`superseded` snapshots still require a sealed count.

M5-B2.1 then removed the Crawlee global-listener growth observed during the 2024 QPC fetch by using `RequestList` for fixed detail-only request sets while retaining `RequestQueue` for dynamic list discovery. The 60-request regression completed without a retained `migrating`/`aborting` listener delta.

M5-B3.1 completed the next 2023 expansion wave on 2026-09-16. QPC snapshot `f7356ffa-e45e-453d-a6e3-bfffe92ea688` sealed and verified 45/45 items; DC snapshot `8c1a5ea8-b221-4b78-8df1-e74ef51e6da1` sealed and verified 15/15 items. Across both snapshots all ten P1 runs succeeded, retryable/terminal failures were zero, active claims were zero after completion, Catalog publications remained zero, and the listener warning did not recur during the 45-item QPC production fetch. See [worldcons-m5b31-france-2023-private-shadow-expansion-20260916.md](./worldcons-m5b31-france-2023-private-shadow-expansion-20260916.md).

M5-B2.2 then implemented the already-approved global-stock + ordered-increment rule before the 2022 wave could write anything. Live read-only verification found that 2022 QPC has two DILA IDs (`CONSTEXT000046216504`, `CONSTEXT000047955984`) for Conseil identity `20225813AN_QPC`, while 2022 DC is missing Conseil identity `2022847DC` from the complete DILA stock+increment overlay. Both conditions are fail-closed under policy v1. No 2022 production snapshot was opened. See [worldcons-m5b22-france-dila-ordered-increment-overlay-20260916.md](./worldcons-m5b22-france-dila-ordered-increment-overlay-20260916.md).

The staged rollout is therefore stopped at 2022. Do not skip to 2021. Continuing requires an explicit reviewed source-policy decision for the duplicate QPC DILA identities and the Conseil-only DC identity; neither may be silently normalized or sourced from an unapproved fallback.

For a newly approved historical tranche, use a scoped environment:

```bash
CASE_CATALOG_FRANCE_HISTORY_ENABLED=true pnpm backfill:corpus discover --source=france --year=2024 --document-type=QPC --policy-version=<reviewed-policy>
```

The command submits a P1 pass by default. `--execute` additionally runs one locally authorized worker command. Keep `CASE_CATALOG_WRITE_ENABLED=false` until inventory, parser fixtures, authority validation, and reconciliation have been reviewed.

Continue with the returned snapshot UUID:

```bash
pnpm backfill:corpus fetch --snapshot=<uuid>
pnpm backfill:corpus normalize --snapshot=<uuid>
pnpm backfill:corpus verify --snapshot=<uuid>
pnpm backfill:corpus reconcile --snapshot=<uuid>
pnpm backfill:corpus status --snapshot=<uuid>
```

Publication is a separate, explicitly enabled Gate 2 operation and is not performed by this Gate 5 expansion.

## Governed transport contract

Both `discover` and `fetch` are governed network phases. The P1 attempt-scoped request governor applies the immutable policy host allowlist, minimum delay, maximum concurrency, lease, and fencing token to every robots, inventory, sitemap, retry, and detail request.

For governed France detail fetches:

- Crawlee uses the HTTP/Cheerio transport only. Playwright is fail-closed because a browser can follow a redirect before the destination receives a separate policy permit.
- redirect following is disabled. A 3xx response releases the current permit and fails the attempt; the worker never authorizes an unknown destination implicitly.
- one permit remains held until the complete response body is available to the Cheerio handler. Every Crawlee retry obtains a new permit and the error/finalization paths release outstanding permits.
- the legacy process-local raw cache is bypassed, so an authoritative backfill fetch cannot be mistaken for a previously cached discovery result.
- missing or unverified official response bodies fail the fetch phase. They do not become metadata-only fetch artifacts.
- nested sitemap requests and governor-only robots checks preserve the same governor instead of falling into the legacy ungoverned cache path.

These controls only make the approved run enforceable. The source policy is approved and recognized by the guard; they do not by themselves apply the migration, enable `CASE_CATALOG_FRANCE_HISTORY_ENABLED`, publish Catalog rows, or write source data.

## Public attribution invariant

Every published France Catalog source anchor must carry the exact immutable `sourceInventory` object sealed into its closed snapshot. PostgreSQL rejects publication when the DILA identity, stock filename and long URL, stock timestamp, archive hash, or Open Licence attribution is missing, malformed, or not byte-for-byte equal to an inventory item in that snapshot.

The public article detail, print document, standard ChatGPT plugin `search`/`fetch` results, and paged source-text result all derive their Korean attribution from that same object. They identify DILA as provider, link the downloaded stock and Licence Ouverte 2.0, state the source-file timestamp, distinguish official source material from any optional AI summary, and state that reuse does not imply endorsement by DILA or the Conseil constitutionnel. Invalid legacy-shaped metadata is not rendered as attribution and cannot enter the France Catalog through the guarded publication transition.

## Verification evidence

For each snapshot retain:

- DILA base stock filename, long URL, file timestamp, ETag, compressed size, SHA-256, plus append-only ordered post-stock increment enumeration artifacts, compact chain summary, and exact final in-scope count;
- official annual/type URL and independently observed facet count;
- page count and pagination exhaustion marker;
- unique manifest count and hash;
- parser/fetch contract versions;
- source policy version and review deadline;
- excluded jurisdiction/type statement;
- item-level authority, date, and official path verification outcomes.

The authoritative official references are:

- <https://www.conseil-constitutionnel.fr/les-decisions>
- <https://www.conseil-constitutionnel.fr/decisions/qpc>
- <https://www.conseil-constitutionnel.fr/decisions/dc>
- <https://www.data.gouv.fr/datasets/constit-les-decisions-du-conseil-constitutionnel>
- <https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/>
- <https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/DILA_CONSTIT_Presentation_20170824.pdf>
- <https://www.data.gouv.fr/pages/legal/licences/etalab-2.0>
- <https://qpc360.conseil-constitutionnel.fr/recherche/jurisprudence>
