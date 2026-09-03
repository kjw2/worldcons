# France CONSTIT source-policy review — 2026-09-03

## Decision

Status: **READY FOR OWNER APPROVAL; NO POLICY ROW OR SOURCE DATA WRITTEN**.

The official DILA `CONSTIT` open-data stock is the preferred primary inventory for the France constitutional-case backfill. The Conseil constitutionnel annual/type HTML pages remain an independent count and canonical-detail cross-check; they are no longer the sole evidence of corpus completeness.

This review authorizes implementation and read-only fixtures. It does not identify a human `reviewed_by`, choose the first `review_due_at`, insert an immutable `source_corpus_policies` row, enable `CASE_CATALOG_FRANCE_HISTORY_ENABLED`, run a production backfill, publish Catalog rows, or send source text to Gemini.

## Official evidence

Observed at `2026-09-03T14:07:08Z` unless a more precise response time is recorded below.

| Evidence | Observation | Consequence |
| --- | --- | --- |
| Conseil constitutionnel dataset page | The producer is the Conseil constitutionnel. The dataset says it contains references for all decisions since 1958 and full text for the listed categories, including DC since 1958 and QPC since 2010. It is marked `Licence Ouverte / Open Licence`. | The dataset is an authoritative official corpus source, not a third-party index. |
| DILA CONSTIT presentation | DILA identifies the Conseil constitutionnel as producer, describes the corpus as all Conseil decisions since 1958, provides XML with the Légifrance DTD, requires a first-time integrator to use the latest stock, and says updates may be supplied up to five times per week. | Discovery must start from the latest global stock and later apply increment archives in order. |
| Open Licence 2.0 | Reproduction, extraction, transformation, redistribution, publication, and commercial/non-commercial reuse are permitted. Source and last-update attribution are mandatory, and reuse must not imply official endorsement or mislead about content, source, or update date. | Full-text processing is legally supported, but provenance and non-endorsement must be preserved. |
| DILA attribution requirement | The presentation specifically requires DILA attribution, the long download URL, downloaded filename, and file date. | These fields are mandatory publication provenance, not optional diagnostics. |
| DILA robots endpoint | `GET https://echanges.dila.gouv.fr/robots.txt` returned `404`; body SHA-256 `80c3fe2ae1062abf56456f52518bd670f9ec3917b7f85e152b347ac6b6faf880`. The official presentation explicitly offers direct, free server access. | Record the missing robots document exactly. Do not invent allow/disallow rules; continue to enforce the reviewed host, one concurrent request, delay, lease, and fencing policy. |
| Conseil robots endpoint | It disallows `/recherche/`, language variants, `/cc-webservice/`, and facet query patterns. It does not disallow `/decision/` or the annual `/les-decisions/annee/...` pages used for cross-checking. SHA-256 `525843eecaf872f1d9a51a5d017ec2bafd70d20a590a17ac815e3d8cc4865cf5`. | Never migrate the backfill to the prohibited search endpoints. Detail and bounded annual-count probes remain policy-controlled cross-checks only. |
| French public-law distribution decree | Légifrance's public service includes decisions transmitted by the Conseil constitutionnel and provides direct, linked, or API access to the legal data. | Corroborates the official distribution role; the dataset licence remains the operative reuse basis for this pipeline. |

Primary references:

- <https://www.data.gouv.fr/datasets/constit-les-decisions-du-conseil-constitutionnel>
- <https://www.data.gouv.fr/api/1/datasets/constit-les-decisions-du-conseil-constitutionnel/>
- <https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/>
- <https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/DILA_CONSTIT_Presentation_20170824.pdf>
- <https://www.data.gouv.fr/pages/legal/licences/etalab-2.0>
- <https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000413818>
- <https://www.conseil-constitutionnel.fr/robots.txt>

QPC360's legal notice is relevant only if QPC360 becomes a primary corpus source later. QPC360 is not part of this policy version or manifest.

## Live archive and count reconciliation

The latest global stock advertised on the observed directory was:

```text
filename: Freemium_constit_global_20250713-140000.tar.gz
url: https://echanges.dila.gouv.fr/OPENDATA/CONSTIT/Freemium_constit_global_20250713-140000.tar.gz
content-length: 12,511,366 bytes
last-modified: 2025-07-13T07:05:03Z
etag: "bee886-639ca2984a5c0"
sha256: 67270556060b481ec139f21436244af913cccd3eb6e074c65d6600f48596f627
xml members: 7,112
```

The stock contains one `TEXTE_JURI_CONSTIT` XML document per archive member. Stable fields observed in the official XML include `ID`, `NATURE`, `TITRE`, `DATE_DEC`, `NUMERO`, `URL_CC`, `ECLI`, and the full `TEXTE/BLOC_TEXTUEL/CONTENU` body.

The 2024 canary was reconciled without database writes:

| Exact scope | DILA latest stock | Conseil annual/type facet | Result |
| --- | ---: | ---: | --- |
| `DATE_DEC=2024-*` and `NATURE=QPC` | 42 | 42 | exact match |
| `DATE_DEC=2024-*` and `NATURE=DC` | 12 | 12 | exact match |

One 2024 document has `NATURE=LP` and `NATURE_QUALIFIEE=DC05`. Counting by `NATURE_QUALIFIEE` prefix would incorrectly produce 13 DC records. The manifest filter must therefore use exact `META_COMMUN/NATURE`, not a qualified-nature prefix.

Example identity observed for the 2024 QPC canary:

```text
ID: CONSTEXT000050783534
NATURE: QPC
DATE_DEC: 2024-12-13
NUMERO: 2024-1115
URL_CC: http://www.conseil-constitutionnel.fr/decision/2024/20241115QPC.htm
ECLI: ECLI:FR:CC:2024:2024.1115.QPC
```

`URL_CC` is normalized to HTTPS and must match the allowlisted Conseil host and `/decision/{year}/{record}.htm` path before it can become an item `discovered_url`. The DILA `ID` is retained in `stable_item_key` and provenance; the Conseil path record remains available for authority-path verification.

## Proposed immutable policy row

The following is a proposal, not an executable migration or approved insert:

```yaml
source_key: fr-conseil-constitutionnel
policy_version: france-dila-constit-2026-09-v1
official_scope_url: https://www.data.gouv.fr/datasets/constit-les-decisions-du-conseil-constitutionnel
discovery_methods:
  - official_dila_constit_latest_stock
  - official_conseil_annual_type_crosscheck
authority_hosts:
  - echanges.dila.gouv.fr
  - www.conseil-constitutionnel.fr
redirect_hosts: []
robots_url: https://echanges.dila.gouv.fr/robots.txt
robots_rules_hash: 80c3fe2ae1062abf56456f52518bd670f9ec3917b7f85e152b347ac6b6faf880
terms_url: https://www.data.gouv.fr/pages/legal/licences/etalab-2.0
license_basis: licence-ouverte-2.0
default_text_access_policy: full
allow_raw_snapshot: false
normalize_replay_policy: bounded_evidence
bounded_replay_fields:
  - sourceKey
  - url
  - canonicalUrl
  - title
  - publishedAt
  - contentType
  - text
  - metadata
min_request_delay_ms: 3000
max_concurrency: 1
external_index_hosts: []
external_index_usage: null
retention_days: OWNER_DECISION_REQUIRED
reviewed_by: OWNER_DECISION_REQUIRED
reviewed_at: OWNER_DECISION_REQUIRED
review_due_at: OWNER_DECISION_REQUIRED
```

The policy `scope_definition` must additionally freeze:

- exact `NATURE in {QPC, DC}` and `DATE_DEC` scope semantics;
- latest-stock selection and ordered increment application rules;
- DILA filename, long URL, file timestamp, ETag, content length, and SHA-256 provenance;
- DILA `ID` as inventory identity, with `ECLI` and decision number as decision identifiers;
- HTTPS normalization and strict validation of `URL_CC`;
- Open Licence attribution and non-endorsement display requirements;
- `aiEgress: denied` for the source-only canary.

Changing `aiEgress` later requires a new immutable policy version and an independently gated enrichment rollout. Public data status alone must not silently enable Gemini transfer.

## Implementation contract

The next implementation stage must satisfy all of these requirements before a policy row is approved:

1. Discover the current directory and select exactly one latest `Freemium_constit_global_*.tar.gz` stock; reject duplicate, malformed, redirecting, oversized, or non-HTTPS candidates.
2. Fetch the directory and stock through the distributed source request governor. Hold the stock permit until the body is completely available and fail on redirects.
3. Bound compressed and expanded bytes, archive member count, individual member size, path syntax, duplicate paths, and duplicate DILA IDs. Reject traversal, links, devices, unknown record roots, and malformed tar headers.
4. Parse XML without resolving external entities or fetching DTDs. Require exact `ORIGINE=CONSTIT`, `JURIDICTION=Conseil constitutionnel`, requested `NATURE`, in-scope `DATE_DEC`, valid `ID`, and valid Conseil `URL_CC`.
5. Use `stable_item_key=constit:<lowercase DILA ID>`. Preserve the DILA ID, ECLI, number, title, stock provenance, and XML member path in bounded replay metadata.
6. Compare the DILA scope count with the official Conseil annual/type facet. A mismatch leaves the snapshot open and fails discovery; it never degrades silently to one source.
7. Keep QPC and DC in separate immutable snapshots. Exclude QPC360 and every non-QPC/DC `NATURE` from this canary.
8. Preserve the source-only rule: no Gemini summary or embedding calls in inventory, fetch, normalize, verify, or Catalog publication.
9. Before public publication, prove that the article detail and plugin responses expose required DILA attribution and update provenance without suggesting Conseil/DILA endorsement.

## Approval checklist

An owner can approve the first immutable policy only after the implementation tests pass and these three human decisions are recorded:

- the named reviewer (`reviewed_by`);
- the policy review deadline (`review_due_at`);
- the per-case bounded replay retention period (`retention_days`).

Until then, the correct operational state is: code and read-only verification allowed; production source policy, inventory writes, Catalog writes, public flags, and AI egress disabled.

## Implementation progress

Completed in the first post-review implementation stage:

- bounded governed directory and stock fetch;
- strict latest-stock selection;
- bounded tar.gz decompression and member validation;
- entity/DTD-free XML parsing;
- exact QPC/DC `NATURE` scope filtering;
- DILA-to-Conseil exact identity-set reconciliation;
- read-only live verification of the 2024 QPC 42/42 and DC 12/12 scopes.

Still required before owner approval and any production inventory write:

- persist DILA item provenance through the immutable manifest into bounded replay metadata;
- expose and verify required DILA attribution on public article/plugin representations;
- add database-level tests for the new provenance contract;
- record the owner decisions listed above and insert the immutable policy row only after those checks pass.
