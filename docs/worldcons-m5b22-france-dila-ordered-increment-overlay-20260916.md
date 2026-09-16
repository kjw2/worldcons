# WorldCons M5-B2.2 — France DILA ordered-increment overlay hardening (2026-09-16)

## Outcome

M5-B2.2 implements a source-policy requirement that was already present in the approved immutable policy `france-dila-constit-2026-09-v1`: discovery starts from the latest official DILA `Freemium_constit_global_*.tar.gz` stock and then applies every later official `CONSTIT_*.tar.gz` increment in ascending extraction order.

This stage did **not** widen the approved France scope, enable public Catalog writes, enable Gemini/AI egress, or write a 2022 production inventory snapshot. It corrected the read-only/private-shadow inventory implementation before M5-B3.2 could continue.

Implementation commit: `d23c068 fix: apply france dila increment overlay`.

## Trigger

The first 2022 read-only reconciliation exposed two independent source-shape problems while the implementation was still global-stock-only:

- `QPC`: the DILA stock contains 68 in-scope DILA IDs but only 67 Conseil decision identities. `20225813AN_QPC` is represented by two DILA IDs: `CONSTEXT000046216504` and `CONSTEXT000047955984`.
- `DC`: the DILA stock contains 12 identities while the Conseil annual/type facet contains 13. The Conseil-only identity is `2022847DC`.

The approved policy already required ordered increments after the base stock. The live DILA directory on 2026-09-16 advertised 21 post-stock increment archives after `Freemium_constit_global_20250713-140000.tar.gz`. Diagnostic comparison proved that increments can update historical records, including three 2022 QPC records and one 2024 DC record. Therefore proceeding with a stock-only implementation would have violated the approved policy semantics.

## Implementation

`lib/crawlee/france-dila-constit.ts` now:

- parses exactly one latest same-origin HTTPS global stock plus bounded `CONSTIT_*.tar.gz` increments produced after that stock;
- orders increments deterministically by official extraction timestamp and filename;
- fetches the directory, stock, and each increment through the existing governed bounded transport with redirects disabled and the reviewed request delay/concurrency controls;
- validates stock and increment tar archives with the same bounded size, checksum, path, entry-type, UTF-8/XML, jurisdiction, authority-URL, and entity/DTD restrictions;
- canonicalizes the increment archive timestamp prefix back to the existing `constit/global/CONS/TEXT/...` member-path contract;
- overlays records only by the same DILA ID, with a later increment replacing the earlier representation of that DILA ID;
- fails closed if two distinct effective DILA IDs point to the same Conseil decision identity. The approved policy defines the DILA ID itself as the stable inventory identity, so this layer does not invent a canonical winner;
- records base-stock provenance and, for records whose effective representation came from an increment, the winning increment provenance;
- records the full per-archive provenance (base stock plus every applied increment: filename, URL, extraction timestamp, `Last-Modified`, ETag, length, SHA-256, expanded size, XML count, and application order) as append-only `source_inventory_enumeration_artifacts`, whose ordered digest is sealed into the snapshot manifest;
- keeps `coverage_evidence` compact: it stores only the applied increment count, cumulative XML count, effective target-record count, first/last increment filenames, enumeration-artifact count, and a SHA-256 chain commitment over the ordered increment provenance. This avoids the 16 KiB `coverage_evidence` ceiling becoming an accidental much-lower increment limit;
- keeps the exact Conseil annual/type identity-set reconciliation mandatory.

No existing migration was edited and no new migration was required. The already-deployed enumeration-artifact ledger (`20260903185000_constitutional_case_enumeration_artifacts.sql`) provides append-only per-archive evidence and seals its digest into the closed snapshot manifest. The existing bounded item-provenance contract accepts the additive winning-increment evidence while retaining the required base-stock attribution fields. Public Catalog rollout remains separately gated; this stage does not change public attribution rendering.

## Fail-closed 2022 result

After removing an unsafe draft behavior that would have automatically chosen one DILA ID for a duplicate Conseil identity, live read-only verification produced the intended failures:

```text
2022 QPC
case_backfill.france_dila_conseil_identity_duplicate:20225813an_qpc:
dila=CONSTEXT000046216504,CONSTEXT000047955984

2022 DC
case_backfill.france_inventory_identity_mismatch:dila=;web=2022847dc
```

Consequences:

- no 2022 production snapshot was opened;
- no 2022 source-backfill item was written;
- no publish command was submitted;
- no Catalog publication was created;
- no Gemini/AI call was enabled;
- rollout does not skip ahead to 2021 while the 2022 tranche is unresolved.

Resolving either anomaly requires an explicit reviewed source-policy decision. In particular, code must not silently deduplicate the two QPC DILA identities or synthesize the missing DC case from a secondary source under the current v1 policy.

## Read-only regression against completed tranches

The ordered overlay was re-run against already completed France years without rewriting their immutable production snapshots:

| Scope | DILA + 21 increments | Conseil facet | Result |
| --- | ---: | ---: | --- |
| 2024 QPC | 42 | 42 | exact identity-set match |
| 2024 DC | 12 | 12 | exact identity-set match |
| 2023 QPC | 45 | 45 | exact identity-set match |
| 2023 DC | 15 | 15 | exact identity-set match |

The 2024 DC diagnostic confirmed that at least one historical XML record was actually changed by a later increment even though the final Conseil identity set and count remained 12/12. This is why the increment overlay is a correctness requirement rather than optional metadata enrichment.

The existing 2024 and 2023 production snapshots remain immutable and were not rewritten in this stage. M5-B2.2 is a read-only provenance/corpus revalidation plus implementation hardening; future discovery uses the corrected ordered-overlay path.

## Verification

Final controller verification after restoring fail-closed duplicate handling:

```text
pnpm typecheck                                             PASS
France Gate5 focused test                                 25 pass / 0 fail
pnpm lint                                                  PASS
pnpm check                                                 PASS
pnpm test:backfill                                         127 pass / 0 fail / 1 skip
pnpm test:p1                                               22 pass / 0 fail / 1 skip
pnpm test:ingest-workflow                                  18 pass / 0 fail
pnpm test:catalog                                          13 pass / 0 fail / 1 skip
pnpm test:postgres:release:static                          7 pass / 0 fail
git diff --check                                           PASS
```

The skipped PostgreSQL integration cases are the pre-existing local-environment skips; the release static gate still enforces skip-0 in the disposable PostgreSQL release workflow.

## Current rollout state

- M5-B2.2 ordered-increment implementation: complete (`d23c068`).
- M5-B3.1 France 2023 QPC/DC: remains completed and read-only revalidated.
- M5-B3.2 France 2022 QPC/DC: **blocked, no production writes**.
- M5-B3.3 France 2021 QPC/DC: not started; staged newest-to-oldest rollout stops at the 2022 blocker.
- Catalog/public/Gemini: remain disabled.

Final production read-only audit after the implementation commit preparation confirmed `france_2022_snapshots = 0` and France Catalog publications `= 0`. Running readiness without the process-scoped history flag still returned `case_backfill.france_history_disabled`, with `publicCatalogWrites = 0` and `geminiCalls = 0`.
