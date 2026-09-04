# Germany BVerfG source-policy review — 2026-09-04

## Decision

Status: **POLICY APPROVED FOR UNATTENDED PRIVATE-SHADOW OPERATION; PUBLICATION REMAINS GATED**.

The declared corpus is the set of decisions that the Bundesverfassungsgericht publishes on its official website from 1998 through the snapshot date, plus any older decision that is actually present there. The court describes this set as all significant decisions since 1998 and some older decisions; it does not claim that every decision issued by the court is online. WorldCons must therefore call the scope the “officially published website corpus”, not the court's complete decisional output.

The owner applied the unattended-operations principle on 2026-09-04: conservative values are approved automatically and the exact decision is retained for audit. Migration `20260903188000_constitutional_case_germany_policy_approval.sql` inserts the immutable policy row. This approval permits the private 2024 shadow inventory after the read-only readiness gate passes. It does not publish Catalog rows, enable public flags, or send German source text to Gemini.

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

## Approved immutable policy values

These are the exact values sealed by policy version `bverfg-unattended-canary-v1`:

```text
source_key: de-bverfg
scope: official BVerfG website decision publications, one calendar year per snapshot
discovery_methods:
  - external_index_dejure_paged_listing
authority_hosts:
  - www.bundesverfassungsgericht.de
redirect_hosts:
  - www.bverfg.de
external_index_hosts:
  - dejure.org
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
  - metadata
min_request_delay_ms: 30000
max_concurrency: 1
external_index_usage: discovery identity only; no external text in public or AI evidence
retention_days: 90
reviewed_by: WorldCons owner via unattended automatic approval
reviewed_at: 2026-09-04T00:00:00Z
review_due_at: 2027-03-03T00:00:00Z
robots_rules_hash: 7565360aa0562e6f2a86d90f58566885b8bf9106e6e493453f1fc9079837e17f
```

The first canary stays `metadata_only` because the official notice's non-alteration requirement must be reconciled with WorldCons normalization before full text is publicly projected. Private bounded evidence retains only the approved replay fields for 90 days. The approval treats dejure as a discovery-identity aid only, excludes Open Legal Data from the first canary, requires the Korean source-integrity notice, and requires `external_index_assisted` to be shown without a complete-corpus claim. Gemini egress remains denied for inventory, fetch, normalize, verify, and source-only Catalog publication.

### Immutable approval audit

The migration stores the following decision in `scope_definition.approval`, so the audit record survives independently of this document:

```text
approvalId: bverfg-unattended-approval-2026-09-04
mode: unattended_automatic
authority: worldcons_owner
boundedEvidenceRetentionDays: 90
policyReviewIntervalDays: 180
externalIndexAccess: dejure_listing_discovery_only
openLegalDataUse: excluded_from_first_canary
publicTextPosture: metadata_only
publicIntegrityNotice: bverfg-korean-integrity-v1
coverageLabel: external_index_assisted_no_complete_corpus_claim
canaryVisibility: private_shadow
geminiEgress: denied
```

The migration is intentionally conflict-detecting. Reapplying the exact policy is a no-op; finding the same `(source_key, policy_version)` with any different approval value raises `BVERFG_UNATTENDED_POLICY_APPROVAL_CONFLICT`. Any later review must create a new immutable policy version through `supersedes_policy_version`.

The first production discovery sealed snapshot `63d50ccb-9824-4460-bb06-049e410b3015` with 288 items, 17 listing-page artifacts, one boundary probe, item manifest `24fd78271c88f77dc4420e8f44336aa1318140eca6ea6b1116310506ea64b8ba`, and enumeration manifest `a71a4c9569bc728d376831cf5a51264a0872cf37b7e8c75c82558266f68902ce`. The first canary correctly stopped before fetch because the public-attribution validator accepted only `rk/rs` filenames and rejected 88 valid candidates using the reviewed `qk/qs/cs/ls/es/fs/bs` procedure prefixes. Migration `20260903189000_constitutional_case_germany_official_url_prefixes.sql` aligns the database allowlist with the existing resolver without accepting arbitrary prefixes. One unresolved candidate exposed a dejure label containing a duplicated date prefix before `1 BvR 2231/23`; it is not silently dropped.

Because the unresolved item changes immutable discovery identity, the sealed snapshot is not edited in place. Migration `20260903190000_constitutional_case_snapshot_supersession.sql` provides a CAS-protected `closed -> superseded` transition and an append-only audit ledger. It permits replacement only while the snapshot is still discovery-only: any processing run, artifact, article link, active claim, or active request permit blocks the transition. The replacement snapshot uses parser version `bverfg-official-normalize-v2`, preserves the raw malformed docket in inventory metadata, and records the conservative normalization rule. Replaying the exact supersession request is a no-op; changing its digest, count, actor, reason, or parser version is a conflict.

Production applied that migration and superseded snapshot `63d50ccb-9824-4460-bb06-049e410b3015` at `2026-09-04T06:29:20.466653+00:00`. The immutable audit row records prior parser `bverfg-official-normalize-v1`, replacement parser `bverfg-official-normalize-v2`, reason `duplicate-date-docket-parser`, actor `worldcons-unattended-operations`, the exact prior manifests, and count `288`. The replacement discovery sealed snapshot `d6c7b404-2252-4369-a719-8e17d2dfaba2` with `287` items, 17 listing-page artifacts, one boundary probe, item manifest `7971b3b988a338896bfc156f56ca9bbb81fe113e9db0eafd8f4cab4e36df3446`, and enumeration manifest `f353a780f426bc2acd750fefeb9a233fab5a6fa32e0b9d66c33c4e160c9a2cd3`. It has zero unresolved or invalid inventory rows and zero Catalog, public, or AI writes.

The `288 -> 287` change is a proven identity merge, not an unexplained loss. The superseded snapshot contained both `dejure:2024-07-02:1bvr223123` and malformed `dejure:2024-07-02:20720241bvr223123` for the same decision. The replacement contains one `dejure:2024-07-02:1bvr223123` item whose immutable metadata preserves raw docket `2.07.2024 - 1 BvR 2231/23`, normalization rule `strip_redundant_date_prefix_v1`, and the resolved official BVerfG URL. Fetch may proceed only against this replacement snapshot.

The first production fetch canary processed one replacement-snapshot item under command `c0b189c8-4d31-46b2-9b50-934b24fce865`, run `376a8acd-3a68-41a4-8343-032efb640932`, and fenced attempt `bd1cc48b-5da9-493b-809d-1a1ef4c4da5e`. Both bounded official URL candidates completed after one transient pre-TLS retry, the worker exited successfully with `claimed=1`, `succeeded=1`, and `failed=0`, and status reported `needsNormalize=1` with no active claim or retry wait. The post-run private-shadow check still reported zero article links, zero Catalog publications, zero AI payloads, and `geminiCalls=0`; its only blocker remained the expected `private_shadow_items_incomplete` until the remaining private phases finish.

The next bounded fetch pass preserved four additional artifacts but its P1 attempt `0a2121f4-07a9-4256-ab91-462d026f5205` terminated with the deliberately redacted `internal` code while the fifth claimed item was waiting on the official source. The attempt-release trigger placed only that item in `retry_wait`; it did not roll back or duplicate the four completed append-only artifacts. A one-item recovery pass (`673d942b-a8fe-44db-bc81-916855a16b77`) succeeded and cleared the retry. The resulting five artifacts were normalized by command `e4b95e35-f912-43e9-8dde-477b2b403be5` and authority-verified by command `b04ebef5-ac35-439f-a7fd-b5e6cd44700c`. The production shadow now reports `verifiedCount=5`, `invalidVerifiedAuthorityCount=0`, no retry/claim/terminal failure, and still zero linked articles, Catalog publications, AI payloads, or Gemini calls. This proves the complete private fetch-to-verification vertical slice while leaving the remaining 282 items intentionally incomplete.

Production timing also showed that a generic default batch of 50 is too broad for this source: the approved 30-second interval and up to two official URL candidates make a BVerfG fetch pass materially longer than normalize or verify. The CLI therefore defaults only `de-bverfg` fetch to two items per P1 pass; every other source/phase keeps the generic default of 50, and an explicit `--batch-limit` remains an audited operator override. This bounds failure recovery and lease exposure without weakening the immutable source policy or increasing concurrency.

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

The public-attribution guard required by step 6 is also implemented in advance. It fail-closes Germany Catalog publication unless the authoritative BVerfG URL, exact sealed inventory item, dejure page and boundary-probe evidence, and source identifier all match. The website, print page, and ChatGPT response identify dejure only as a discovery aid and state that German official text is authoritative. The approved policy authorizes step 5 only after readiness passes; step 6 remains separately gated by the private-shadow canary and public feature flags.

After the immutable policy migration is applied, run `pnpm verify:bverfg-shadow-readiness -- --year=2024 --policy-version=bverfg-unattended-canary-v1` before any inventory write command. The read-only result is `ready` only when the history flag and every reviewed policy constraint match, `complete` only for a closed snapshot with both item and enumeration manifest hashes, and otherwise `blocked` with machine-readable reasons. The check never inserts a policy, opens a snapshot, enables public Catalog data, or authorizes a production write.

`pnpm backfill:corpus` also invokes the same readiness contract before every Germany write submission. A blocked policy, disabled history flag, mismatched snapshot, or competing open snapshot fails before a P1 command is created. In this readiness vocabulary, `complete` means that the inventory manifest is sealed, not that fetch/normalize/verify/reconcile have all finished: a repeated discovery is rejected, while later phases may use only the exact sealed snapshot ID. This distinction is covered by the operation-planning tests so discovery closure cannot deadlock the remaining pipeline.

After fetch, normalize, verify, and reconciliation passes finish, run `pnpm verify:bverfg-shadow-canary -- --snapshot=<uuid>`. A pass requires the recomputed enumeration digest, contiguous page evidence, one stable boundary probe, every item either officially verified or explicitly excluded, no pending claims/retries/failures, no linked or published Catalog article, and zero AI payloads. This canary is also read-only and cannot convert the private shadow into a public release.

1. Make the durable request governor phase-aware: external index hosts are discover-only, while fetch remains restricted to authority/redirect hosts.
2. Add a bounded, resumable Germany annual scope and P1 strategy without changing the daily crawler's operational limit.
3. Build an append-only external enumeration artifact with provider page/count/hash evidence and no external full text.
4. Resolve each candidate to official BVerfG detail candidates, then verify ECLI/docket/date/type against official content.
5. Close a 2024 private-shadow snapshot only after all configured enumeration sources and reconciliation checks complete.
6. Publish an `authoritative_source` Catalog canary with Gemini calls fixed at zero and public attribution enforced in the database.

## Approval gate outcome

The owner resolved the production policy decisions under the unattended automatic-approval principle:

- reviewer: `WorldCons owner via unattended automatic approval`;
- bounded evidence retention: 90 days;
- policy review due: 2027-03-03 (180 days after approval);
- dejure: approved only for listing-based discovery identity;
- Open Legal Data: excluded from the first canary;
- first canary: private, `metadata_only`, Korean integrity notice required;
- coverage: `external_index_assisted`, with no complete-corpus claim;
- Gemini: denied throughout the private shadow.

The migration, private discovery, audited supersession, and corrected rediscovery are complete. The remaining operational gate is to run fetch, normalize, verify, and reconciliation against replacement snapshot `d6c7b404-2252-4369-a719-8e17d2dfaba2`, then pass `verify:bverfg-shadow-canary`. Catalog writes, public flags, and AI egress remain disabled until their later gates pass.
