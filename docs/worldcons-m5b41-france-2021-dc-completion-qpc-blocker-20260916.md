# WorldCons M5-B4.1 — France 2021 QPC/DC completion

Date: 2026-09-16

Status: **COMPLETE — 2021 QPC (75/75) AND 2021 DC (21/21) PRODUCTION PRIVATE-SHADOW VERIFIED, AFTER A REVIEWED GLUE-TOLERANT TITLE-GATE REMEDY. PUBLICATION/AI REMAIN OFF.**

## Scope

This stage ran the next newest-to-oldest France historical expansion wave under the owner-approved successor policy:

- source: `fr-conseil-constitutionnel`
- policy: `france-dila-constit-2026-09-v2`
- year: 2021
- document types: QPC, then DC
- execution: P1 command-control / fencing only (process-scoped flags, no direct DML)
- Catalog publication: disabled (`CASE_CATALOG_WRITE_ENABLED=false`)
- Gemini/AI: disabled
- Orca: not used
- no commit, push, or deploy

The two axes are reported separately per the canonical policy
`docs/worldcons-historical-backfill-operating-principles-20260916.md`:

- **corpus_backfill_complete:** 2021 QPC = yes (75/75); 2021 DC = yes (21/21).
- **public_enrichment_complete:** no (publication and Gemini remain intentionally off).

Execution proceeded in two steps. The first pass stopped 2021 QPC fail-closed on an
official-source title anomaly; a reviewed, glue-tolerant title-gate remedy was then
implemented, tested, and re-verified at 75/75 before the 2021 QPC production run.
2021 DC was unaffected and completed in the first pass.

## Live read-only inventory verification (immediately before execution)

Both facets re-downloaded the official DILA `CONSTIT` latest global stock plus all 21 ordered post-stock increments and independently paginated the official Conseil annual/type facet.

- stock: `Freemium_constit_global_20250713-140000.tar.gz`
- stock SHA-256: `67270556060b481ec139f21436244af913cccd3eb6e074c65d6600f48596f627`
- ordered increments applied: 21
- cumulative XML members: 7,600
- increment-chain hash: `556e75db2021b0396125bb880555f831c79da554a1a31ed8ba2201114529562d`

### 2021 DC — PASS

- expected/discovered: **21/21**
- exact DILA↔Conseil identity-set match: yes
- exception applications: 0 (E1/E2 do not apply to 2021)
- pageCount: 1

### 2021 QPC — PASS after the reviewed title-gate remedy

The first live verifier run failed inside the Conseil facet phase, before any DILA↔Conseil
reconciliation:

```text
{"event":"france_dila_conseil_inventory_verification_failed",
 "error":"France Conseil inventory count mismatch: expected 75, discovered 73."}
```

Exact evidence (independent read-only probe of
`https://www.conseil-constitutionnel.fr/les-decisions/annee/2021/type/qpc?items_per_page=100&sort_by=cc_date_1`):
the official active-type facet counts **75** and exposes **75** decision anchors, but only **73**
passed the then-current `\bQPC\b` gate. The two dropped official QPC decisions render the type
token glued to the following lowercase French word (confirmed on both the facet and the detail
pages, `og:title`/`h1.title`):

| Conseil record | official title as published |
| --- | --- |
| `2021897QPC` | `Décision n° 2021-897 QPCdu 16 avril 2021` |
| `2021911_919QPC` | `Décision n° 2021-911/919 QPCdu 4 juin 2021` |

No 2021 QPC snapshot, run, item, claim, or write was created on that first pass, and the rollout
did not skip to 2020.

After the remedy below was implemented and tested, the same live read-only verifier reported
**expected 75 / discovered 75 with an exact DILA↔Conseil identity-set match** and **zero**
exception applications (E1/E2 do not apply to 2021), using the same approved stock/chain hashes.

## Glue-tolerant title-gate remedy

The fix centralizes the discovery and verify type check in one exported helper.

- `lib/crawlee/france-conseil-inventory.ts` — `titleMatchesType` is replaced by the exported
  `franceConseilTitleMatchesType(title, documentType)`. It still accepts the normal
  word-boundary form (`\bQPC\b` / `\bDC\b` on the diacritic-normalized, upper-cased title) and
  additionally accepts the exact marker directly followed by a lowercase letter
  (`QPCdu`, `DCdu`), i.e. the official glued rendering.
- `lib/backfill/source-strategies.ts` — the France verify strategy now calls the same helper
  instead of its own duplicate `\bQPC\b`/`\bDC\b` test, so discovery and verify can never diverge.
  This was required because the 2021 detail pages also emit the glued `QPCdu` in `og:title` and
  `h1.title`, which the verify `resolution_type_mismatch` gate would otherwise reject.

Guardrails preserved: a following digit (`QPC360`), a glued uppercase continuation (`QPCDU`),
a different typed token, and cross-facet titles (`DC` on a QPC request and vice versa) are all
still rejected. Regression coverage was added in
`tests/constitutional-case-backfill-france-gate5.test.ts` for the positive `QPCdu`/`DCdu` cases
and those negative cases, both at the list parser and at the verify-strategy level.

## 2021 QPC production private shadow

Snapshot:

`b41c2224-58a8-4323-8f63-09ee198eab9c`

Closed manifest hash:

`959c26b6b168189b7630424b150a8ba29083dc966cf54032d2691bf2a5e53456`

Enumeration manifest hash:

`a081d71937850015e01a811b10ab9f4a8f5046c0a8b5f6d4ce2429a43bc79b37`

Final database evidence:

- expected/discovered: 75/75
- item status: 75 `verified`
- fetch: 75/75
- normalize: 75/75
- verify: 75/75
- item errors: 0
- active claims after completion: 0
- retryable failures: 0
- terminal failures: 0
- E1/E2 exception items: 0 (none apply to 2021)

P1 audit trail (all succeeded):

| phase | command | run | attempt |
| --- | --- | --- | --- |
| discover | `096b238a-6dc1-4cc8-97fe-2a2e0d19fec5` | `764ee8ef-14d2-497f-a05a-c76f0d6fa57b` | `7897e13c-a737-49f0-80d5-3250755f39ab` |
| fetch | `e3d8eb62-ea80-41cd-b449-915462bca6ca` | `4aae0d2e-2c4b-4ede-87b0-fc17f525842d` | `ecf6c5a1-f198-48b5-9400-0220fd550cf3` |
| normalize | `38470651-72dc-4c81-beff-4ce960c06102` | `775e6a26-d3b7-4ed3-8284-05c953b0460e` | `14ffaf9d-cee1-4c69-bfd7-a2a36965684f` |
| verify | `e1261025-66fc-478c-8c79-44582db2a79b` | `84c0da1a-1c8f-4e4a-8afd-c63b28ce8660` | `d658afbc-3e99-4f59-ba3d-d50df57039d1` |
| reconcile | `a912cf19-057c-444d-a16f-30e455a7d2c5` | `b32c250a-ccbe-40c4-988c-e7f7a00ea355` | `77017cee-3d35-4eb2-8229-6adcf6b76d29` |

## 2021 DC production private shadow

Snapshot:

`a604f20a-433b-4b48-b11b-03168cfccb31`

Closed manifest hash:

`26f1d80c29b4ffc7b4505625489f36651721fffc9d0488e53de9e125a510eff4`

Enumeration manifest hash:

`a081d71937850015e01a811b10ab9f4a8f5046c0a8b5f6d4ce2429a43bc79b37`

Final database evidence:

- expected/discovered: 21/21
- item status: 21 `verified`
- fetch: 21/21
- normalize: 21/21
- verify: 21/21
- item errors: 0
- active claims after completion: 0
- retryable failures: 0
- terminal failures: 0
- E1/E2 exception items: 0 (none apply to 2021)

P1 audit trail (all succeeded):

| phase | command | run | attempt |
| --- | --- | --- | --- |
| discover | `d2e34b15-bd5e-476a-9e80-f534bcccaa7c` | `70ece96c-3a1c-47e9-ac90-b15a80b91bc7` | `64760533-df77-4388-bbf4-92432aad93ac` |
| fetch | `c042b490-91ce-4087-a729-ae41f16cf156` | `7c413f6b-cc1c-4f59-9f8e-ad5dadd58fd3` | `224c0d4a-6e4e-4287-ab5d-50706485d34f` |
| normalize | `dbe5f0dd-31a3-4c66-9922-3b7e153d8e3f` | `839c203b-8c0b-48fa-a089-28e7d9d47b0f` | `522cb5d3-3068-4998-912c-63406b4dbf56` |
| verify | `d20624b0-fb20-4d6d-884a-048ba98c4c0a` | `8d9bcf05-06cc-4ce8-b0c2-47a69bca603e` | `1e0d52c6-52cf-4d6a-a0ac-fc4f17bc9405` |
| reconcile | `375ecbb5-e51f-485f-b3de-8dca843af147` | `c3da1b78-c323-4641-a3b4-c9687613d863` | `bc337ecc-48c9-4a69-ad11-68474c9c13f6` |

## Combined operational audit

- 2021 QPC: 75/75 authoritative items discovered, fetched, normalized, verified
- 2021 DC: 21/21 authoritative items discovered, fetched, normalized, verified
- 0 item errors, 0 retryable failures, 0 terminal failures, 0 active claims
- 0 `p1.case-backfill.publish` commands (these snapshots and globally, to date)
- 0 rows in `case_catalog_publications_v1`
- every phase preflight reported `publicCatalogWrites=0` and `geminiCalls=0`
- the pre-existing closed snapshots are unchanged:
  - 2024 QPC: `9e61bcc34d61d99a8f6216b287cfd13ab9290a687368f5e304e7ca58abea4523`
  - 2024 DC: `b88b4a0d1d0a28a22a9e5304663db18cb3daf5918340167bd253bb477baadd5f`
  - 2023 QPC: `71e2aecebd5a55882ce576e6bbcfbd497d1352d8036536c216b9fe645a64e03b`
  - 2023 DC: `0c65b361ac6b460dcf147c70f0f031b84b6b394e2c30a2de8ba9bb694135d400`
  - 2022 QPC: `3955d040bb54995ef26ac7b7c292371c4d2d4c1764e6d4b65ca9d3b2eaf03188`
  - 2022 DC: `70fa8c53373c4473a658638d2d86a4a825a0555fba4bf7cd1d06b1c4dd257a88`

## Fail-closed state after execution

The France history flag and P1 authority flags were supplied only to the bounded execution processes. After those processes exited, the default environment again reports:

- `policyAuthorized=true`
- `executionEnabled=false`
- `allowed=false`
- `errorCode=case_backfill.france_history_disabled`
- `publicCatalogWrites=0`
- `geminiCalls=0`

## Verification commands

- `pnpm typecheck` — pass
- `pnpm lint` — pass
- `pnpm check` — `All checks passed.`
- `pnpm test:backfill` — 145 tests, **144 pass / 0 fail / 1 skip** (existing disposable-PostgreSQL skip; includes the 2 new glue-tolerance regression tests)
- `pnpm test:catalog` — 14 tests, **13 pass / 0 fail / 1 skip**
- `pnpm test:postgres:release:static` — **7 pass / 0 fail / 0 skip**
- `git diff --check` — pass

## Progress accounting

France QPC/DC production corpus completion advances from **6/30 to 8/30**:

- 2024 QPC/DC: complete
- 2023 QPC/DC: complete
- 2022 QPC/DC: complete
- 2021 QPC: **complete**
- 2021 DC: **complete**
- 2020–2010: pending

The next newest-to-oldest acquisition frontier is **2020**, which requires a new bounded
execution step; this completion does not automatically start 2020.
