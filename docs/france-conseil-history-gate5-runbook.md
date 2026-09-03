# France Conseil constitutionnel QPC/DC Gate 5 runbook

## Scope and safety state

This stage supports one immutable snapshot per calendar year and decision facet for Conseil constitutionnel decisions from 2010 through the current UTC year.

- source: `fr-conseil-constitutionnel`
- document types: `QPC` and `DC` only
- primary inventory: the official Conseil annual/type result pages
- authority detail: `https://www.conseil-constitutionnel.fr/decision/{year}/{record}.htm`
- coverage: `authoritative_counted` only when the official active-type facet count equals the unique manifest count
- public Catalog and Gemini: not enabled by this stage

QPC and DC use separate snapshots. QPC360 results from Conseil d'État, Cour de cassation, and other courts are outside this first France scope. QPC360 is not part of the primary manifest until its export terms and stable automated contract are reviewed in a versioned source policy.

## Fail-closed rules

Discovery stops without closing the manifest when any of these conditions occurs:

1. `CASE_CATALOG_FRANCE_HISTORY_ENABLED` is not exactly `true`.
2. The year is before 2010 or after the current UTC year.
3. The document type is not QPC or DC.
4. robots policy rejects the official annual/type path.
5. the active official facet count is missing or changes during pagination.
6. pagination does not exhaust within the configured bound.
7. the unique official detail links do not equal the fixed expected count.

Sitemap `lastmod` values are update metadata and never become decision dates. Dates come from the official decision title/detail and must remain within the snapshot year.

## Planning without writes

```bash
pnpm backfill:corpus plan --source=france --year=2024 --document-type=QPC
pnpm backfill:corpus plan --source=france --year=2024 --document-type=DC
```

Both plans report `executionEnabled: false` under the default environment.

The official inventory contract can be checked without database writes:

```bash
pnpm verify:france-inventory --year=2024 --document-type=QPC
```

This read-only probe still obeys robots policy, request delay, timeout, bounded pagination, and count reconciliation.

## Private-shadow execution prerequisites

Do not enable the flag from this runbook alone. Before execution, an operator must create and review an immutable `source_corpus_policies` row covering the official list/detail paths, robots observation, text egress, bounded replay fields, request delay, concurrency, retention, and `review_due_at`.

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

## Verification evidence

For each snapshot retain:

- official annual/type URL and observed expected count;
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
- <https://qpc360.conseil-constitutionnel.fr/recherche/jurisprudence>
