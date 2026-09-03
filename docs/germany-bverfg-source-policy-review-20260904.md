# Germany BVerfG source-policy review — 2026-09-04

## Decision

Status: **IMPLEMENTATION REVIEW COMPLETE; POLICY AND PRODUCTION EXECUTION BLOCKED**.

The declared corpus is the set of decisions that the Bundesverfassungsgericht publishes on its official website from 1998 through the snapshot date, plus any older decision that is actually present there. The court describes this set as all significant decisions since 1998 and some older decisions; it does not claim that every decision issued by the court is online. WorldCons must therefore call the scope the “officially published website corpus”, not the court's complete decisional output.

This review authorizes code, fixtures, and bounded read-only verification. It does not insert an immutable `source_corpus_policies` row, enable a Germany history flag, open a production inventory snapshot, publish Catalog rows, or send German source text to Gemini.

## Evidence observed

Observed at `2026-09-03T21:20:31Z` unless stated otherwise.

| Evidence | Observation | Consequence |
| --- | --- | --- |
| [BVerfG decisions page](https://www.bundesverfassungsgericht.de/DE/Entscheidungen/entscheidungen_node.html) | HTTP 200. The court says its website contains all significant decisions since 1998 and some older decisions. | The target corpus is the official website publication set, not all decisions ever issued. |
| [BVerfG robots.txt](https://www.bundesverfassungsgericht.de/robots.txt) | HTTP 200. `/SiteGlobals/` is disallowed, the advertised crawl delay is 30 seconds, and `Sitemap_Index.xml` is advertised. | Do not automate the SiteGlobals decision search. Every BVerfG request must use the durable governor with at least a 30-second delay and concurrency 1. |
| [BVerfG sitemap index](https://www.bundesverfassungsgericht.de/Sitemap_Index.xml) and `Sitemap_Basepage.xml` | The index currently points to one base-page sitemap. Read-only inspection found ordinary navigation pages but no `SharedDocs/Entscheidungen` detail URLs. | The advertised sitemap cannot currently prove exhaustive decision enumeration. Preserve this observation and recheck it on each policy review. |
| [BVerfG legal notice](https://www.bundesverfassungsgericht.de/DE/Service/Impressum/impressum_node.html) | Decisions and official headnotes are treated as official works. The notice requires source attribution and forbids alteration; other site content is protected separately. Translations are informational and only German originals are authoritative. | Authority text must come from the official German decision page. Public projection must name the court and link the exact official source. External-index text, surrounding editorial text, images, and layout assets are excluded. |
| [German Copyright Act §5](https://www.gesetze-im-internet.de/urhg/__5.html) | Official decisions and officially drafted headnotes are not protected by copyright under the cited provision. | This supports reuse of the official decision, but does not waive attribution, integrity, privacy, or source-service access controls. |
| BVerfG official detail fixture `rs20210326_2bvr054721.html` | HTTP 200 from `SharedDocs/Entscheidungen/DE/...`. | Official detail pages are the authority and canonical URL target. A derived URL is only a candidate until this response and its identifiers are verified. |
| [dejure BVerfG listing](https://dejure.org/dienste/rechtsprechung?gericht=BVerfG) | HTTP 200. The list exposed 425 pages at observation time. Its generic robots rules do not disallow this listing path; the pending-case sentinel dated `31.12.2222` is explicitly disallowed. | dejure may be an enumeration aid only. Never fetch the disallowed sentinel, never use its text as authority, and preserve page/count/digest evidence. |
| [Open Legal Data imprint](https://de.openlegaldata.io/pages/imprint/) and API robots | The database identifies ODbL 1.0, while robots disallows `/api` and tells bulk consumers to use dumps or the API rather than crawl pages. A read-only API response reported 4,005 BVerfG records. | Do not make the current API a required exhaustive dependency until the owner approves the access interpretation. Prefer a versioned dump or the official federal API for auxiliary reconciliation. |
| [Federal legal-information project](https://digitalservice.bund.de/projekte/neues-rechtsinformationssystem) and [API documentation](https://docs.rechtsinformationen.bund.de/v3/api-docs) | The federal project offers an open API for reuse, updated daily, but its own project notice says the test-phase data set is still being expanded. | It is a valuable official auxiliary identity/source feed, not proof that the BVerfG website corpus is complete. Record its snapshot/version separately. |

## Coverage and identity contract

The first vertical slice is one calendar year of BVerfG website publications. It uses one snapshot with `document_type=DECISION`; individual `Beschluss`, `Urteil`, orders, and other official type labels remain item metadata rather than separate coverage denominators.

The snapshot must use:

```text
coverage_assurance = external_index_assisted
processing denominator = immutable discovered manifest
official corpus coverage = unknown/not 100%
authority source = official BVerfG detail only
canonical URL = official BVerfG detail only
```

The inventory must preserve each enumeration source independently and reconcile their union against successful official-detail verification. A 100% processing result means every manifest item reached a terminal outcome. It must never be presented as 100% coverage of all BVerfG website decisions.

Decision identity precedence is:

```text
ECLI
> official detail URL identity
> docket + decision date + official decision type
```

`Aktenzeichen`/docket is not unique. The known `2 BvR 547/21` decisions dated 2021-03-26 and 2021-04-15 must remain two decisions. External record IDs are provider-scoped discovery identifiers and cannot become the public decision identity by themselves.

## Proposed immutable policy values

These values are a review draft, not an insertable policy row:

```text
source_key: de-bverfg
scope: official BVerfG website decision publications, one calendar year per snapshot
discovery_methods:
  - external_index_dejure_paged_listing
  - official_federal_api_crosscheck
  - open_legal_data_dump_crosscheck_if_approved
authority_hosts:
  - www.bundesverfassungsgericht.de
redirect_hosts:
  - www.bverfg.de
external_index_hosts:
  - dejure.org
  - testphase.rechtsinformationen.bund.de
default_text_access_policy: metadata_only for the first canary
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
  - metadata.ecli
  - metadata.caseNumber
  - metadata.decisionDate
  - metadata.decisionType
  - metadata.externalInventory
min_request_delay_ms: 30000
max_concurrency: 1
external_index_usage: discovery identity only; no external text in public or AI evidence
retention_days: OWNER_DECISION_REQUIRED
reviewed_by: OWNER_DECISION_REQUIRED
reviewed_at: OWNER_DECISION_REQUIRED
review_due_at: OWNER_DECISION_REQUIRED
```

The first canary stays `metadata_only` because the official notice's non-alteration requirement must be reconciled with WorldCons normalization before full text is publicly projected. Private bounded evidence may retain the minimum text needed to verify and normalize only if the owner explicitly approves the retention period. Gemini egress remains denied for inventory, fetch, normalize, verify, and source-only Catalog publication.

## Implementation gaps found by this review

1. `scripts/backfill-corpus.ts` accepts only Spain and France. Germany has no durable annual scope or history flag.
2. `lib/backfill/source-strategies.ts` has no Germany Gate 5 strategy. The existing daily spider is not an exhaustive durable inventory adapter.
3. The current BVerfG spider caps dejure at four pages by default and slices results to the ordinary collection limit. This is valid for daily collection but invalid for an exhaustive snapshot.
4. The current external-index fetches call `fetch` directly and do not acquire the P1/database source request permit.
5. `source_backfill_request_permit_acquire_v1` ignores `external_index_hosts`. Adding those hosts to `authority_hosts` would blur discovery and authority. The governor must allow external hosts only for the `discover` phase and continue to reject them for official `fetch`.
6. A derived official URL is currently marked `sourceUrlVerified: true` before the official detail is fetched. Gate 5 must keep it candidate-only until authority verification succeeds.
7. Public source attribution currently has a France-specific projection. Germany needs an equivalent court/source/integrity notice before Catalog publication can be enabled.

## Required implementation order

Implementation status as of 2026-09-04: steps 1–4 are implemented and covered by database and fixture tests. A read-only `pnpm verify:bverfg-inventory -- --year=2024` command validates the annual boundary, page sequence, evidence hashes, official URL candidates, and the explicit `external_index_assisted` limitation without opening a snapshot or calling Gemini. The append-only enumeration ledger is part of the closed snapshot manifest.

The public-attribution guard required by step 6 is also implemented in advance. It fail-closes Germany Catalog publication unless the authoritative BVerfG URL, exact sealed inventory item, dejure page and boundary-probe evidence, and source identifier all match. The website, print page, and ChatGPT response identify dejure only as a discovery aid and state that German official text is authoritative. This code does not authorize steps 5 or 6 in production; the owner decisions below remain mandatory.

1. Make the durable request governor phase-aware: external index hosts are discover-only, while fetch remains restricted to authority/redirect hosts.
2. Add a bounded, resumable Germany annual scope and P1 strategy without changing the daily crawler's operational limit.
3. Build an append-only external enumeration artifact with provider page/count/hash evidence and no external full text.
4. Resolve each candidate to official BVerfG detail candidates, then verify ECLI/docket/date/type against official content.
5. Close a 2024 private-shadow snapshot only after all configured enumeration sources and reconciliation checks complete.
6. Publish an `authoritative_source` Catalog canary with Gemini calls fixed at zero and public attribution enforced in the database.

## Approval gate

Before any Germany production policy or inventory write, an owner must:

- name the reviewer;
- choose `retention_days` and `review_due_at`;
- approve the interpretation of dejure listing access and any Open Legal Data dump/API use;
- approve the `metadata_only` first-canary posture and the source-integrity notice;
- confirm that `external_index_assisted` is displayed without a false complete-corpus claim.

Until then, code, fixtures, and read-only probes are allowed; production policy rows, inventory writes, Catalog writes, public flags, and AI egress remain disabled.
