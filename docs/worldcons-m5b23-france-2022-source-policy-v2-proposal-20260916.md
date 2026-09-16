# WorldCons M5-B2.3 — France 2022 source-policy-v2 proposal (2026-09-16)

> **Status: PROPOSAL ONLY — NOT OWNER-APPROVED.**
> This document is a design proposal for owner review. It is not an approval, not a policy row,
> not a migration, and not an execution plan that may be run. No `source_corpus_policies` row
> is inserted or changed by this stage, and the existing immutable policy
> `france-dila-constit-2026-09-v1` remains frozen and untouched.

## 1. Scope and safety state of this stage

This stage produced documentation only. While preparing it:

- no code and no migration was modified;
- no production database was read or written for policy mutation, and no snapshot, backfill item,
  claim, or run was created or changed;
- no 2022 backfill or snapshot was opened; no Catalog publication was created;
- no Gemini/AI call was enabled or made; no push, deploy, or commit was performed;
- Orca was not used and the coordinator SQLite database was not modified;
- the untracked `artifacts/` tree and `docs/worldcons-recovery-and-improvement-plan-20260905.md`
  were not touched;
- the France history execution flag default remains off, so readiness still returns
  `case_backfill.france_history_disabled`, `publicCatalogWrites = 0`, and `geminiCalls = 0`;
- **no progress count changes.** France QPC/DC remains **4/30 production-complete**
  (2024 QPC, 2024 DC, 2023 QPC, 2023 DC) and `approvedSelectionCount` stays 31
  (Germany 2024 DECISION 1 + France QPC/DC 2010–2024 30). The 2022 tranche stays
  **blocked, no production writes**.

## 2. Provenance

This proposal is grounded in the following evidence and does not invent new observations:

- **M5-B2.2 evidence** — `docs/worldcons-m5b22-france-dila-ordered-increment-overlay-20260916.md`.
  It implemented the already-approved "latest global stock + ordered increments" rule and
  documented the two independent 2022 anomalies under the corrected overlay.
- **Prior analysis** — DeepSeek analysis `e3bbdbf5-f51e-4cf7-998b-9662421f5758`, which first
  framed the two anomalies as separate source-policy questions (one DILA *omission*, one DILA
  *identity canonicalization*) rather than a single reconciliation failure.
- **Controller-independent live revalidation on 2026-09-16** — the complete official DILA
  `CONSTIT` stock plus every post-stock ordered increment still produces:
  - 2022 QPC `case_backfill.france_dila_conseil_identity_duplicate:20225813an_qpc:dila=CONSTEXT000046216504,CONSTEXT000047955984`
  - 2022 DC `case_backfill.france_inventory_identity_mismatch:dila=;web=2022847dc`
- **v1 policy record** — `docs/france-constit-source-policy-review-20260903.md` and immutable row
  `fr-conseil-constitutionnel` / `france-dila-constit-2026-09-v1`
  (migration `20260916090000_constitutional_case_france_policy_approval.sql`), whose DILA-ID-as-
  stable-identity rule and exact-identity-set reconciliation are the source of the fail-closed behavior.

No coordinator approval or owner approval for this proposal has been recorded. The proposal has
**not** been submitted to the owner and must not be treated as decided.

## 3. Exact anomalies and why v1 cannot resolve them

v1 fails closed on both 2022 cases because the verified live evidence cannot be reconciled without
an explicit reviewed decision:

1. **2022 DC — official-source omission (E1).** The complete DILA stock plus ordered increments
   contains only 12 effective in-scope DC identities, while the official Conseil annual/type facet
   contains 13. The single Conseil-only identity is `2022847DC`. Under v1 the mismatch fails with
   `france_inventory_identity_mismatch`; v1 expressly forbids synthesizing the case from a
   secondary source.
2. **2022 QPC — DILA identity duplication (E2).** Two distinct effective DILA IDs
   (`CONSTEXT000046216504` and `CONSTEXT000047955984`) carry the same Conseil decision identity
   `20225813AN_QPC`. v1 defines the DILA ID itself as the stable inventory identity and therefore
   fails with `france_dila_conseil_identity_duplicate`; code must not invent a canonical winner.

Both are genuine source-shape facts, not parser bugs. Any automatic resolution (newest-wins,
lower-ID-wins, Conseil-preference) would silently rewrite official identity and is explicitly out
of policy.

### 3.1 External corroboration basis

**DILA itself has no DILA-to-DILA supersession signal.** The official XML members include `ID`,
`ANCIEN_ID`, `NATURE`, `TITRE`, `DATE_DEC`, `NUMERO`, `NOR`, `URL_CC`, and `ECLI`, but no field marks
one current DILA ID as retired, replaced, corrected, or superseded by another current DILA ID.
`ANCIEN_ID` is a legacy identifier crosswalk rather than a DILA-to-DILA version pointer; for both
`CONSTEXT000046216504` and `CONSTEXT000047955984` it is empty. Neither target ID appears in any of
the 21 post-stock increments, so archive order cannot resolve the duplicate either. Therefore E2
cannot be derived from DILA metadata alone. E1 likewise requires external corroboration because the
decision is absent from the complete DILA stock+increment corpus. Both require reviewed, frozen,
exact-tuple exceptions rather than an in-code heuristic.

- **E2 corroboration.** Each candidate DILA record for `20225813AN_QPC` is compared against the
  *current* official Conseil decision page and its live ECLI. The candidate whose official title
  and ECLI match the current Conseil page is the canonical representation; the other candidate is
  the retired/duplicate representation. The frozen conclusion is `matches_current_conseil_title_and_ecli`
  so that later runs replay the reviewed decision rather than re-deriving it.
- **E1 corroboration.** The official Conseil annual/type facet and the official decision page
  independently confirm that `2022847DC` is a real, authoritative Conseil DC decision, while the
  complete DILA stock + ordered-increment overlay verifiably lacks the identity. The reason code
  `dila_omission_verified_absent` records that the absence was checked against the complete corpus,
  not inferred from a partial fetch. The fallback source is the official Conseil authority page,
  not a third-party index.

## 4. Proposed v2 exception model (exact tuples only)

The v2 proposal keeps every v1 invariant and presents **two separate, independently approvable**
narrow exceptions. They must not be bundled into an implicit recovery rule. A future approved v2
policy may contain only the exception(s) the owner explicitly approves. Each approved exception is
a frozen exact tuple, not a general rule; any input that does not match it exactly must continue to
fail closed under the existing v1 codes.

### 4.1 E1 — one-case Conseil provider fallback (2022 DC)

```yaml
exceptionId: e1_conseil_provider_fallback
sourceKey: fr-conseil-constitutionnel
year: 2022
documentType: DC
sourceRecordId: 2022847DC
provider: conseil
reasonCode: dila_omission_verified_absent
authorityUrl: https://www.conseil-constitutionnel.fr/decision/2022/2022847DC.htm
suggestedStableItemKey: constit:conseil-omission:2022847dc
```

- Exactly one record identity. No wildcard, prefix, year range, or nature-wide rule.
- The item's provider is `conseil`, distinguishing it from every DILA-derived item.
- The stable key is deliberately distinct from both `constit:<dilaId>` and `conseil:<recordId>` so
  the fallback can never collide with, or masquerade as, a DILA-derived inventory item.
- After E1, the 2022 DC effective identity set is expected to be 13 (12 DILA-derived + 1
  Conseil-provider), matching the official facet. Counts must be re-confirmed live at execution.

### 4.2 E2 — one DILA canonicalization pair (2022 QPC)

```yaml
exceptionId: e2_dila_canonicalization
conseilRecordId: 20225813AN_QPC
canonicalDilaId: CONSTEXT000047955984
retiredDilaId: CONSTEXT000046216504
basis: matches_current_conseil_title_and_ecli
```

- Exactly one ordered pair. Direction matters and is frozen: `CONSTEXT000047955984` is canonical,
  `CONSTEXT000046216504` is retired.
- The retired ID does not become a second inventory item. It is retained only as retirement
  evidence in the canonical item's provenance (see §5).
- After E2, the 2022 QPC effective identity set is expected to be 67, matching the official facet.
  Counts must be re-confirmed live at execution.

## 5. Provenance design

Provenance must make the exception auditable without weakening the v1 evidence contract.

- **DILA-derived items** keep the complete v1 provenance: DILA ID, exact `NATURE`, ECLI (including
  explicit null), decision number, qualified nature, bound archive member path, base-stock
  filename/URL/extraction timestamp/`Last-Modified`/ETag/length/SHA-256, and the winning increment
  provenance when the effective representation came from an increment.
- **E2 canonical item** additionally records a `retirement` block:
  `{ retiredDilaId, canonicalDilaId, conseilRecordId, basis, verifiedAt, corroborationRef }`.
  The retired ID's membership in the stock/increment must remain visible in the append-only
  enumeration artifacts; only the effective-item projection collapses to one item.
- **E1 Conseil-provider item** uses an explicit non-DILA provenance shape. At minimum it records:
  - `provider: "conseil"`;
  - `conseil: { sourceRecordId: "2022847DC", canonicalUrl, ecli:
    "ECLI:FR:CC:2022:2022.847.DC", decisionNumber: "2022-847",
    decisionDate: "2022-12-29", jorf: "JORF n°0303 du 31 décembre 2022, texte n° 2",
    nor: "CSCL2237744S" }`;
  - `dilaLookup: { stockFilename: "Freemium_constit_global_20250713-140000.tar.gz",
    stockSha256: "67270556060b481ec139f21436244af913cccd3eb6e074c65d6600f48596f627",
    incrementsApplied: 21, memberScanCount, norSearched: "CSCL2237744S", result: "absent",
    observedAt }`;
  - `reasonCode: "dila_omission_verified_absent"` and the exact reviewed authority URL.
  The absence proof is recomputed from the then-current official stock plus every applicable
  ordered increment during each discovery attempt; `memberScanCount`/`observedAt` are run evidence,
  not immutable literals in the policy tuple. The item must not carry a fabricated DILA ID,
  archive member path, or claim that a DILA XML member represented the decision.
- **Exceptions list in the sealed manifest.** The applied exception IDs (E1/E2) and their exact-tuple
  digests must be sealed into the closed snapshot evidence so a later reader can tell that the
  identity set was reconciled under v2, not silently under v1.
- The `coverage_evidence` object stays compact (16 KiB ceiling) and continues to store only
  counts/first/last/chain-hash; the full per-archive evidence stays in the append-only enumeration
  artifact ledger.

## 6. Stable identity design

- DILA-derived stable key stays `constit:<lowercase DILA ID>` (v1).
- E2 does **not** introduce a new key form. The surviving item keeps
  `constit:constext000047955984`; the retired ID is evidence only.
- E1 introduces the single reviewed key form `constit:conseil-omission:<recordId>` for a
  Conseil-provider item. This form is reserved for enumerated v2 fallbacks and is not a general
  pattern; it must be rejected unless it matches an approved E1 tuple exactly.
- Authority-URL validation for the E1 item uses the exact `authorityUrl` from the tuple on the
  allowlisted Conseil host and `/decision/{year}/{record}.htm` path.

## 7. Reconciliation and fail-closed rules

Order of evaluation under proposed v2:

1. Apply the ordered stock+increment overlay exactly as v1 does (same-DILA-ID last-write).
2. Apply E2 only when the effective duplicate pair is exactly
   `20225813AN_QPC` / canonical `CONSTEXT000047955984` / retired `CONSTEXT000046216504`.
   Reversal, a different canonical ID, or a different Conseil record must **not** be canonicalized
   and must still throw `case_backfill.france_dila_conseil_identity_duplicate`.
3. Reconcile the DILA-derived identity set against the official Conseil facet. If E1 matches
   exactly and the facet is missing only `2022847DC`, inject the single Conseil-provider fallback;
   proceed only if the resulting identity set is now exactly equal. Otherwise fail.
4. Any remaining duplicate, any remaining mismatch, or a count mismatch continues to fail with the
   existing codes: `case_backfill.france_dila_conseil_identity_duplicate`,
   `case_backfill.france_inventory_identity_mismatch`, `case_backfill.france_inventory_count_mismatch`.
5. No fallback to a secondary/third-party index, no "prefer Conseil" or "prefer newest" default,
   and no broadening beyond the two tuples.

Additional v2 exception invariants are mandatory:

- `S_dila \\ S_conseil` (DILA surplus) is never allowlisted and always fails closed.
- A Conseil-only identity is admissible only when the exact source/year/type/record/provider/reason/
  authority tuple equals E1. Wildcards, regular expressions, prefixes, ranges, and "same year/type"
  fallback rules are forbidden.
- The complete DILA absence proof for E1 is recomputed on every discovery from the current selected
  stock plus all later ordered increments, including an exact identity/NOR scan; cached prior absence
  evidence cannot authorize the fallback.
- If `2022847DC` later appears anywhere in the effective DILA corpus, E1 is **stale** and discovery
  fails closed pending a newly reviewed policy version. It must not silently prefer either provider.
- If `2022847DC` disappears from the current official Conseil 2022 DC facet or the exact authority
  page no longer corroborates the frozen identity, discovery fails closed; the exception is not
  permission to synthesize a missing Conseil record.
- E2 applies only to the exact three-way identity/pair relationship in §4.2. Any extra DILA ID,
  reversed pair, changed Conseil identity, or corroboration drift fails closed.

Fail-closed conditions that remain unchanged: history flag not exactly `true`; policy version not
the approved one; year outside 2010–2024; non-QPC/DC nature; any transport/archive/XML contract
violation; ambiguous stock/increment selection; facet count missing or changing during pagination;
pagination not exhausted.

## 8. Additive new-timestamp migration design (design only — do not implement)

No migration is created in this stage. When and only when the owner approves v2, the change is an
**additive** new migration that preserves v1 byte-for-byte:

- **New file only**, e.g. `supabase/migrations/<new-timestamp>_constitutional_case_france_policy_v2_approval.sql`.
  The existing `20260916090000_constitutional_case_france_policy_approval.sql` is never edited.
- The new migration inserts a second immutable `source_corpus_policies` row:
  - `source_key`: `fr-conseil-constitutionnel`
  - `policy_version`: `france-dila-constit-2026-09-v2`
  - `supersedes_policy_version`: `france-dila-constit-2026-09-v1`
  - `scope_definition`: the v1 scope **plus** a bounded `exceptions` block containing only the E1
    and/or E2 tuple(s) separately and explicitly approved by the owner. Approval of one must not be
    inferred as approval of the other.
- All other fields (hosts, robots hash, terms/licence, retention, delay, concurrency, replay
  fields, `aiEgress: denied`) stay identical to v1.
- The migration follows the v1 conflict-detecting, idempotent pattern: a rerun may only observe the
  exact same row or raise `FRANCE_CONSTIT_POLICY_V2_APPROVAL_CONFLICT`. It must never update or
  delete the v1 row.
- **v1 stays immutable.** Existing closed 2024/2023 snapshots remain bound to the exact v1 policy
  and are never rewritten. If approved, v2 becomes the reviewed successor for future discovery;
  `supersedes_policy_version` records lineage rather than mutating or deleting the v1 row.
- Required code/DB follow-up (also not implemented here) would update
  `lib/backfill/france-scope.ts` to recognize the reviewed v2 row,
  `lib/backfill/country-history-policy.ts` to keep the same approved 2010–2024 QPC/DC boundary,
  `lib/crawlee/france-dila-constit.ts` to apply only the exact approved E1/E2 tuple(s), and
  `lib/backfill/rollout-readiness.ts` to report the reviewed version without changing the default
  execution flag. The database change should be additive: a v3 France inventory upsert (or an
  equivalently strict additive branch) accepts the E1 non-DILA provenance shape only for the exact
  approved tuple, while the existing v1/v2 DILA paths remain strict.

```yaml
# Illustrative exceptions block (design only; not an executable migration)
exceptions:
  e1ConseilProviderFallback:
    - sourceKey: fr-conseil-constitutionnel
      year: 2022
      documentType: DC
      sourceRecordId: 2022847DC
      provider: conseil
      reasonCode: dila_omission_verified_absent
      authorityUrl: https://www.conseil-constitutionnel.fr/decision/2022/2022847DC.htm
      suggestedStableItemKey: constit:conseil-omission:2022847dc
  e2DilaCanonicalization:
    - conseilRecordId: 20225813AN_QPC
      canonicalDilaId: CONSTEXT000047955984
      retiredDilaId: CONSTEXT000046216504
      basis: matches_current_conseil_title_and_ecli
```

## 9. Public attribution design (design only)

Catalog publication stays disabled; this section defines behavior if a later, separately gated
publication stage is approved.

- **DILA-derived items** keep the v1 public attribution exactly: provider DILA, stock filename and
  long URL, stock timestamp, archive hash, and Open Licence 2.0, with the non-endorsement notice.
- **E2 canonical item** renders as the single DILA item identified by `CONSTEXT000047955984`. The
  retirement of `CONSTEXT000046216504` is audit evidence, not a second public source anchor; the
  public page must not imply two independent DILA sources.
- **E1 Conseil-provider item** renders a distinct attribution: provider **Conseil constitutionnel**,
  the official `authorityUrl`, and the Conseil decision identity. It must **not** claim DILA stock
  provenance it does not have, and it must accurately state that the case was absent from the DILA
  corpus. Non-endorsement language for both DILA and the Conseil constitutionnel is preserved.
- The existing publication trigger, which requires exact DILA provenance for France anchors, must
  be extended additively (new migration, design only) with a v2 validator such as
  `case_catalog_france_inventory_attribution_valid_v2` and a corresponding publication guard that
  accepts the Conseil-provider provenance shape only for the exact approved E1 tuple and v2 policy
  version, while still accepting the existing strict DILA shape and rejecting every other non-DILA
  shape. Until that separately gated change exists, an E1 item cannot pass the current trigger —
  which is the correct fail-closed default today.

## 10. Tests (design only)

Proposed coverage, all to be authored only after approval:

- **E1 positive:** exact tuple yields exactly one Conseil-provider item with stable key
  `constit:conseil-omission:2022847dc`, correct provider, authority URL, and omission evidence.
- **E1 near-miss fail-closed:** wrong year, type, record ID, provider, authority URL, reason code,
  or a different missing identity must still raise `france_inventory_identity_mismatch`.
- **E1 stale fail-closed:** if `2022847DC` appears in DILA later, or disappears from the official
  Conseil facet/authority evidence, discovery fails instead of silently choosing a source.
- **E1 absence replay:** each discovery re-scans the selected stock + all ordered increments for
  identity and NOR; cached absence evidence cannot satisfy the exception.
- **E2 positive:** exact pair yields one effective item `CONSTEXT000047955984`, excludes
  `CONSTEXT000046216504` from the effective set, and records the retirement block.
- **E2 near-miss fail-closed:** reversed direction, different canonical ID, or a different Conseil
  record must still raise `france_dila_conseil_identity_duplicate`.
- **No widening:** any third duplicate or mismatch beyond E1/E2 still fails with the v1 codes.
- **No wildcard fallback:** regex/prefix/range/general "DILA missing => Conseil" behavior is rejected.
- **DILA surplus:** any DILA-only Conseil identity remains an unconditional mismatch.
- **Reconciliation:** 2022 QPC reconciles to the official facet after E2; 2022 DC reconciles to the
  official facet after E1 (expected 67 and 13 respectively, re-confirmed live).
- **Read-only regression:** 2024 QPC 42/42, 2024 DC 12/12, 2023 QPC 45/45, 2023 DC 15/15 remain
  exact identity-set matches, and their closed production snapshots are byte-for-byte unchanged.
- **Policy immutability:** v1 row is unchanged; the v2 migration is conflict-detecting and
  idempotent; `supersedes_policy_version` is correct.
- **Flag/egress:** default `case_backfill.france_history_disabled`; `publicCatalogWrites = 0`;
  `geminiCalls = 0`.
- **Runner checks:** `pnpm typecheck`, `pnpm lint`, `pnpm check`, `pnpm test:backfill`,
  `pnpm test:p1`, `pnpm test:catalog`, `pnpm test:postgres:release:static`, `git diff --check`.

## 11. Immutability, rollout stop, and flags

- **2024 and 2023 snapshots remain immutable.** v2 affects future discovery only; no closed
  snapshot or sealed manifest is rewritten. The read-only revalidation is evidence, not mutation.
- **Default `CASE_CATALOG_FRANCE_HISTORY_ENABLED` remains off.** Readiness continues to return
  `case_backfill.france_history_disabled` unless a bounded process supplies the flag explicitly.
- **Catalog publication and Gemini/AI remain disabled** (`CASE_CATALOG_WRITE_ENABLED`,
  `CASE_CATALOG_PUBLIC_ENABLED`, `CASE_CATALOG_PLUGIN_ENABLED` unchanged; `aiEgress: denied`).
- **Staged rollout stops at 2022.** Rollout stays newest-to-oldest; 2021 must not start while the
  2022 tranche is unresolved. No 2022 production snapshot is opened under this proposal stage.

## 12. Decision requested (not yet granted)

Owner review is requested for exactly two decisions:

1. Approve or reject **E1** — the single Conseil-provider fallback for `2022847DC` (2022 DC).
2. Approve or reject **E2** — the single DILA canonicalization pair for `20225813AN_QPC`
   (2022 QPC).

No action may be taken on the basis of this proposal. It confers no authorization, inserts no
policy row, widens no scope, and does not change the 4/30 production-complete progress.

## References

- `docs/worldcons-m5b22-france-dila-ordered-increment-overlay-20260916.md`
- `docs/france-constit-source-policy-review-20260903.md`
- `docs/france-conseil-history-gate5-runbook.md`
- `docs/worldcons-m5-rollout-readiness-runbook.md`
- `supabase/migrations/20260916090000_constitutional_case_france_policy_approval.sql`
- Prior analysis `e3bbdbf5-f51e-4cf7-998b-9662421f5758`
- <https://www.conseil-constitutionnel.fr/decision/2022/2022847DC.htm>
- <https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/>
