# France Conseil constitutionnel QPC/DC Gate 5 runbook

## Scope and safety state

This stage supports one immutable snapshot per calendar year and decision facet for Conseil constitutionnel decisions from 2010 through the current UTC year.

- source: `fr-conseil-constitutionnel`
- document types: `QPC` and `DC` only
- primary inventory: the latest official DILA `CONSTIT` global stock, filtered by exact `NATURE` and decision year
- independent count cross-check: the official Conseil annual/type result pages
- authority detail: `https://www.conseil-constitutionnel.fr/decision/{year}/{record}.htm`
- coverage: `authoritative_crosschecked` only when the DILA stock scope count, official active-type facet count, and unique manifest count all match
- public Catalog and Gemini: not enabled by this stage

QPC and DC use separate snapshots. QPC360 results from Conseil d'État, Cour de cassation, and other courts are outside this first France scope. QPC360 is not part of the primary manifest until its export terms and stable automated contract are reviewed in a versioned source policy.

The source-policy evidence and proposed immutable row are in [france-constit-source-policy-review-20260903.md](./france-constit-source-policy-review-20260903.md). That review is ready for owner approval but is not itself an approved policy row.

## Fail-closed rules

Discovery stops without closing the manifest when any of these conditions occurs:

1. `CASE_CATALOG_FRANCE_HISTORY_ENABLED` is not exactly `true`.
2. The year is before 2010 or after the current UTC year.
3. The document type is not QPC or DC.
4. the DILA directory or stock request violates the reviewed host, redirect, byte, archive, lease, or fencing contract.
5. latest-stock selection is ambiguous or the stock/XML structure is malformed.
6. the active official facet count is missing or changes during pagination.
7. pagination does not exhaust within the configured bound.
8. the exact DILA `NATURE` count, unique manifest count, and official Conseil facet count differ.

Sitemap `lastmod` values are update metadata and never become decision dates. Dates come from the official decision title/detail and must remain within the snapshot year.

## Planning without writes

```bash
pnpm backfill:corpus plan --source=france --year=2024 --document-type=QPC
pnpm backfill:corpus plan --source=france --year=2024 --document-type=DC
```

Both plans report `executionEnabled: false` under the default environment.

The existing Conseil count probe can be checked without database writes:

```bash
pnpm verify:france-inventory --year=2024 --document-type=QPC
```

This read-only probe still obeys robots policy, request delay, timeout, bounded pagination, and count reconciliation. The DILA stock parser and three-way reconciliation probe are required by the next implementation stage before this runbook may be used for production execution.

## Private-shadow execution prerequisites

Do not enable the flag from this runbook alone. Before execution, an owner must approve the review document, choose its explicit reviewer/retention/review deadline, and create the resulting immutable `source_corpus_policies` row. The policy must cover the DILA directory/stock, Conseil count/detail cross-checks, robots observations, attribution, AI egress denial for the source-only canary, bounded replay fields, request delay, concurrency, retention, and `review_due_at`.

After that approval, use a scoped environment:

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

These controls only make a future approved run enforceable. They do not approve Conseil constitutionnel collection, create a source policy, enable `CASE_CATALOG_FRANCE_HISTORY_ENABLED`, or write source data.

## Verification evidence

For each snapshot retain:

- DILA stock filename, long URL, file timestamp, ETag, compressed size, SHA-256, and exact in-scope count;
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
