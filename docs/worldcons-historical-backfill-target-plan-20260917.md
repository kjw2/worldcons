# WorldCons historical backfill target-count and acquisition plan

Date: 2026-09-17

Status: **CANONICAL target-count and acquisition plan for the four-country Gate 5 historical constitutional-case backfill (2025+ excluded).**

> **Canonical operating policy:** `docs/worldcons-historical-backfill-operating-principles-20260916.md`. This document only fixes the *denominators/targets* and the acquisition frontier; it does not change the acquisition-first, AI/publication-later rule or the two completion axes.

This plan consolidates the two completed read-only audits (the France corpus/target audit and the Germany/United States/Spain target-count audit). It is a documentation-only milestone. No backfill code, source governor, migration, production data, Catalog publication, or Gemini/publication path was changed. Orca was not used. `artifacts/` and `docs/worldcons-recovery-and-improvement-plan-20260905.md` were not touched.

## 1. Scope and the 2025+ boundary

Gate 5 historical scope is the four sources below for years **up to and including 2024**. **2025 and later are owned by the incremental ingestion workflow and are excluded from every Gate 5 denominator in this document.** This mirrors `CASE_HISTORY_BOUNDARY` (`historicalMaxYear=2024`, `incrementalOwnedFromYear=2025`, `rule=pre_2025_gate5_historical`).

A denominator or frontier is only ever stated for the historical (<=2024) portion. Adding 2025+ items must never change a Gate 5 target or completion percentage.

## 2. Target classes

Every country target is labeled with exactly one class. The class describes *what the number is allowed to claim*, not how important the work is.

| Class | Name | Meaning | Allowed claim |
| --- | --- | --- | --- |
| **A** | authoritative exact | A reproducible official denominator that is the declared scope's own complete publication set, reconciled 1:1 against an official inventory. | "Exact official target; scope complete when all items reach a terminal corpus outcome." |
| **B** | operational enumerator target | A sealed, resumable enumeration target used to drive processing, where the enumerator is an external index or an advertised-but-not-exhaustive official listing. | "Operational processing target; **no** exhaustive official completeness claim." |
| **C** | not yet fixable | No trustworthy denominator exists because an audited access/legal/structural constraint blocks enumeration. | "Target unknown (NULL); blocked by a named constraint." |

Rules:

- **Only France (class A) has a numerically fixed total target today.** Germany, the United States, and Spain are explicitly NULL; NULL is an audited state, **not a guessed zero and not an implicit "0 done"**.
- A class B target is never presented as 100% official corpus coverage; its 100% means "every item in the sealed manifest reached a terminal outcome".
- A class C target is not an actionable denominator until its blocking constraint is resolved in M1.
- Completion is always reported on the two axes of §6, never as an unqualified "complete".

## 3. France — class A (exact target)

- source: `fr-conseil-constitutionnel`
- document types: `QPC`, `DC`
- scope: 2010-2024 (Gate 5)
- approved policy: `france-dila-constit-2026-09-v1`, additive successor `france-dila-constit-2026-09-v2`, and additive successor `france-dila-constit-2026-09-v3` (adds exactly six 2017 QPC DILA-omission tuples)
- coverage assurance: `authoritative_crosschecked` only when the DILA stock+ordered-increment identity set, the official Conseil active-type facet identity set, and the unique manifest count all match

**Exact target: 1,280 documents = 1,005 QPC + 275 DC.**

Basis: the official Conseil annual/type facet (the year facet on a type-filtered page) independently cross-checked against the DILA `CONSTIT` latest global stock plus ordered post-stock increments. The per-year values were re-observed read-only on 2026-09-17 and reconcile exactly to the audited totals (QPC 1,005; DC 275; total 1,280).

| Year | QPC | DC | Total | Corpus status |
| ---: | ---: | ---: | ---: | --- |
| 2010 | 64 | 24 | 88 | pending |
| 2011 | 110 | 23 | 133 | pending |
| 2012 | 74 | 17 | 91 | pending |
| 2013 | 66 | 22 | 88 | pending |
| 2014 | 67 | 24 | 91 | pending |
| 2015 | 68 | 18 | 86 | pending |
| 2016 | 81 | 18 | 99 | pending |
| 2017 | 75 | 14 | 89 | pending |
| 2018 | 64 | 19 | 83 | pending |
| 2019 | 61 | 19 | 80 | pending (next frontier) |
| 2020 | 46 | 16 | 62 | complete |
| 2021 | 75 | 21 | 96 | complete |
| 2022 | 67 | 13 | 80 | complete |
| 2023 | 45 | 15 | 60 | complete |
| 2024 | 42 | 12 | 54 | complete |
| **Total** | **1,005** | **275** | **1,280** | — |

Production corpus completion:

- **complete: 352 / 1,280 (10 tranches, 2020-2024)**;
- **remaining: 928 / 1,280 (20 tranches, 2010-2019)**;
- **next frontier: 2019**, then newest-to-oldest.

The two approved 2022 source-policy exceptions are inside this exact target and do not change it: one E2 DILA canonicalization (retired `CONSTEXT000046216504` → canonical `CONSTEXT000047955984`) and one E1 Conseil-only DC fallback (`2022847DC`). The 2017 QPC frontier additionally required six exact E1 Conseil-only QPC fallbacks (`2016613QPC`, `2017663QPC`, `2017664QPC`, `2017665QPC`, `2017666QPC`, `2017670QPC`), authorized by `france-dila-constit-2026-09-v3`; they are inside the same exact 75-count target and do not change it. A read-only 2016-2010 characterization found no further omissions or duplicate identities.

All of the above is `corpus_backfill_complete`; `public_enrichment_complete` is false (Catalog and Gemini remain off).

## 4. Germany — class B (operational enumerator target, total NULL)

- source: `de-bverfg`
- document type: `DECISION`
- scope: 1998-2024 official website publication set — the decisions the Bundesverfassungsgericht publishes on its official website from 1998 through the snapshot date. This is **not** the court's complete decisional output.
- coverage assurance: **`external_index_assisted`** (dejure paged listing for discovery identity; official BVerfG detail is the only authority). The advertised sitemap cannot prove exhaustive enumeration, so **no official exhaustive-completeness claim is made**.
- processing denominator: each year's immutable sealed manifest, not a claimed official corpus size.

Sealed targets:

| Year | Sealed target | State | Snapshot | Manifest |
| --- | ---: | --- | --- | --- |
| 2024 | **287** | complete (253 verified + 34 explicit excluded) | `d6c7b404-2252-4369-a719-8e17d2dfaba2` | `7971b3b988a338896bfc156f56ca9bbb81fe113e9db0eafd8f4cab4e36df3446` |
| 2023 | **354** | in progress (fetch drain live) | `57948d51-1300-4ff1-86db-be00a6572bc9` | `d93af2b195b2ec0b667f8c56f46c20e4b7a6ea74dc9bd9431d4bf3439c745c76` |

**Total target for 1998-2024: NULL.** It can only be fixed after one full reviewed dejure enumeration for the whole 1998-2024 window can run **after the current 2023 fetch drain is idle**. Until then, per-year sealed manifests are the only admissible denominators.

Rejected alternative denominator: the safe official Federal Legal Data Portal (the federal legal-information project/API) returned **2024 = 271** against the sealed **287**. Because it is a different and still-incomplete corpus (the project's own notice says its test-phase data set is still being expanded), it is **not** adopted as the BVerfG denominator.

Operational constraint: the 2023 fetch drain is live. Do not modify backfill code, the source governor, or production data while it runs.

## 5. United States — class C (target NULL)

- source: `us-constitution-annotated` (candidate graph), with `us-scotus` authority/publication as a separate later gate
- scope: Constitution Annotated Table of Cases candidate graph, ≤ 2024
- **Candidate graph only (`US_CONAN_CORPUS_STATUS=candidate_graph_only`), never a verified SCOTUS corpus or a verified constitutional target.**

**Target: NULL.** The interactive official source returns 403 (Cloudflare challenge) and there is no exact structured bulk export of the candidate graph, so no reproducible candidate denominator exists yet.

Two non-denominator proxies that are **not adopted** as the live target:

- GovInfo 2022 Appendix / Table of Cases PDF proxy: ~3,213 entries with citation+year / 3,515 citation lines / 5,716 unique U.S. cites. This is a PDF-derived proxy, not an interactive official candidate denominator.
- U.S. Reports: 582 packages / 36,942 granules. This is a separate candidate universe (authority/identity material), not a verified constitutional target and not a candidate-graph target.

M1 direction: obtain a reviewed official fixture/access path, then build the candidate graph and run the candidate → official identity → authority → holding → verified pipeline. No Gemini in this path.

## 6. Spain — class C (target NULL, blocked)

- source: `es-tribunal-constitucional`
- document types: `SENTENCIA` first, then `SENTENCIA`+`DECLARACION`, then `AUTO`
- scope: 2020-2024 `SENTENCIA`, then 1980-2019, then `AUTO`
- policy state: `SPAIN_SENTENCIA_HISTORY_SOURCE_POLICY_STATUS=blocked_pending_legal_robots_review`, `SPAIN_SENTENCIA_HISTORY_SOURCE_POLICY_APPROVED=false`

**Target: NULL, blocked.** HJ `robots.txt` returns HTTP 404 and the Tribunal Constitucional legal notice returns HTTP 403, so the fail-closed source-policy gate is unsatisfied. Every year, including the 2024 baseline, stays `executionEnabled=false`.

Official annual statistics are **not** HJ publication counts and therefore cannot be used as a denominator. The following aggregate `Sentencia` counts are recorded as **non-denominator evidence only**:

| Year | Aggregated `SENTENCIA` count |
| ---: | ---: |
| 2018 | 142 |
| 2019 | 178 |
| 2020 | 195 |
| 2021 | 192 |
| 2022 | 151 |

M1 direction: record an explicit legal/robots decision with evidence, then probe the official HJ annual/type counts before any denominator is proposed.

## 7. Completion axes

Every country/year/type tranche reports two **separate** states (canonical policy §2):

- **`corpus_backfill_complete`** — inventoried, fetched, normalized, verified, reconciled, and sealed with durable provenance.
- **`public_enrichment_complete`** — additionally translated/summarized/enriched and public-published.

These are never collapsed into an unqualified "complete". France, Germany, the United States, and Spain are all `public_enrichment_complete = false`.

## 8. M0 metric gap (`processing_completion` ignores `verified`)

The production status RPC `source_backfill_snapshot_status_v1` computes `terminal_total`/`processing_completion` from item statuses `published`, `excluded`, `duplicate`, `withdrawn`, `waived_failure` only. It **does not count `verified` items**, even though a verified item is a completed corpus-backfill outcome under the canonical policy.

Consequence: a fully fetched + normalized + verified private shadow with publication off reports `processing_completion ≈ 0` while `corpus_backfill_complete` is actually true. This is a metric-semantics defect, not a data defect.

M0 corrective work (recorded here, **not implemented in this documentation-only milestone**): reconcile the RPC metric with the two-axis model — either count `verified` in a corpus-backfill completion metric or expose a distinct verified/`corpus_backfill` count — while preserving the existing published/terminal semantics and changing no production data or the live drain's code path.

## 9. Milestone plan

| Milestone | Goal | Contents |
| --- | --- | --- |
| **M0** | docs / metrics reconciliation | This plan; target classes; the `processing_completion` gap recorded (no code change). |
| **M1** | fix target denominators | FR: **done** (exact 1,280). DE: run one full reviewed dejure enumeration after the 2023 drain is idle. US: reviewed official fixture/access path + candidate graph. ES: legal/robots decision + official counts probe. |
| **M2** | corpus completion | FR 2019 → 2010, one bounded tranche at a time. DE 2023 first, then 2022 → 1998 with per-year owner-approved policy. US candidate → authority/review. ES approved phases once M1 clears. |
| **M3** | public enrichment downstream | Translation/summary/enrichment and public Catalog/P3 release, paced by quota and explicitly separate from M2. |

Cross-cutting constraints for M1/M2: no Orca; no direct production DML (P1 RPCs only); no Catalog/public/AI expansion; preserve immutable snapshots/manifests; do not modify the live Germany drain's code, governor, or data.

## 10. Machine-readable summary

```json
{
  "document": "worldcons-historical-backfill-target-plan-20260917",
  "gate": 5,
  "historicalMaxYear": 2024,
  "incrementalOwnedFromYear": 2025,
  "rule": "pre_2025_gate5_historical",
  "targetClasses": {
    "A": "authoritative_exact",
    "B": "operational_enumerator_target_without_official_completeness_claim",
    "C": "not_yet_fixable"
  },
  "completionAxes": ["corpus_backfill_complete", "public_enrichment_complete"],
  "countries": {
    "france": {
      "sourceKey": "fr-conseil-constitutionnel",
      "documentTypes": ["QPC", "DC"],
      "scope": "2010-2024",
      "targetClass": "A",
      "target": { "total": 1280, "qpc": 1005, "dc": 275 },
      "perYear": {
        "2010": { "qpc": 64, "dc": 24, "total": 88, "corpusComplete": false },
        "2011": { "qpc": 110, "dc": 23, "total": 133, "corpusComplete": false },
        "2012": { "qpc": 74, "dc": 17, "total": 91, "corpusComplete": false },
        "2013": { "qpc": 66, "dc": 22, "total": 88, "corpusComplete": false },
        "2014": { "qpc": 67, "dc": 24, "total": 91, "corpusComplete": false },
        "2015": { "qpc": 68, "dc": 18, "total": 86, "corpusComplete": false },
        "2016": { "qpc": 81, "dc": 18, "total": 99, "corpusComplete": false },
        "2017": { "qpc": 75, "dc": 14, "total": 89, "corpusComplete": false },
        "2018": { "qpc": 64, "dc": 19, "total": 83, "corpusComplete": false },
        "2019": { "qpc": 61, "dc": 19, "total": 80, "corpusComplete": false },
        "2020": { "qpc": 46, "dc": 16, "total": 62, "corpusComplete": true },
        "2021": { "qpc": 75, "dc": 21, "total": 96, "corpusComplete": true },
        "2022": { "qpc": 67, "dc": 13, "total": 80, "corpusComplete": true },
        "2023": { "qpc": 45, "dc": 15, "total": 60, "corpusComplete": true },
        "2024": { "qpc": 42, "dc": 12, "total": 54, "corpusComplete": true }
      },
      "corpusComplete": { "items": 352, "tranches": 10, "years": "2020-2024" },
      "remaining": { "items": 928, "tranches": 20, "years": "2010-2019" },
      "nextFrontier": 2019,
      "publicEnrichmentComplete": false
    },
    "germany": {
      "sourceKey": "de-bverfg",
      "documentType": "DECISION",
      "scope": "1998-2024",
      "targetClass": "B",
      "coverageAssurance": "external_index_assisted",
      "officialExhaustiveClaim": false,
      "target": { "total": null, "reason": "requires one full reviewed dejure enumeration after the current drain is idle" },
      "sealedTargets": { "2024": 287, "2023": 354 },
      "sealedDetail": {
        "2024": { "verified": 253, "excluded": 34, "state": "complete" },
        "2023": { "state": "in_progress" }
      },
      "rejectedDenominator": {
        "source": "official federal legal data portal",
        "year": 2024,
        "count": 271,
        "reason": "different and incomplete corpus; sealed target is 287"
      },
      "publicEnrichmentComplete": false
    },
    "unitedStates": {
      "sourceKey": "us-constitution-annotated",
      "corpusStatus": "candidate_graph_only",
      "scope": "<=2024",
      "targetClass": "C",
      "target": { "total": null, "reason": "interactive official source 403; no exact structured bulk" },
      "govinfo2022PdfProxy": {
        "entriesWithCitationAndYear": 3213,
        "citationLines": 3515,
        "uniqueUsCites": 5716,
        "adoptedAsLiveTarget": false
      },
      "usReportsCandidateUniverse": {
        "packages": 582,
        "granules": 36942,
        "verifiedConstitutionalTarget": false
      },
      "publicEnrichmentComplete": false
    },
    "spain": {
      "sourceKey": "es-tribunal-constitucional",
      "documentType": "SENTENCIA",
      "scope": "2020-2024, then 1980-2019, then AUTO",
      "targetClass": "C",
      "target": { "total": null, "reason": "policy blocked: HJ robots 404 and legal notice 403" },
      "nonDenominatorEvidence": {
        "sentenciasAggregate": { "2018": 142, "2019": 178, "2020": 195, "2021": 192, "2022": 151 }
      },
      "publicEnrichmentComplete": false
    }
  },
  "metricGap": {
    "rpc": "source_backfill_snapshot_status_v1",
    "field": "processing_completion",
    "issue": "terminal_total excludes verified items",
    "milestone": "M0",
    "implementedInThisMilestone": false
  },
  "milestones": {
    "M0": "docs/metrics reconciliation",
    "M1": "fix target denominators",
    "M2": "corpus completion",
    "M3": "public enrichment downstream"
  }
}
```

## 11. Wording rules (non-regression)

- Only France's total target (1,280) is numerically fixed. Germany, the United States, and Spain are **NULL because audited** — never write them as `0` and never infer a guessed number.
- Germany's target is operational (`external_index_assisted`); never claim official exhaustive completeness for the BVerfG website corpus.
- The US candidate graph is never a verified SCOTUS/constitutional corpus; the GovInfo PDF proxy and U.S. Reports counts are not live targets.
- Spain's official annual statistics are not HJ publication counts and are not a denominator.
- 2025+ is incremental ingestion and never enters a Gate 5 denominator.
- `corpus_backfill_complete` and `public_enrichment_complete` stay separate.
