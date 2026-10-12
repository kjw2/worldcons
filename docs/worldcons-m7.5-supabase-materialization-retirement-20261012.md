# M7.5 Supabase materialization retirement — 2026-10-12

The original local commit `7666e63896298db2303846b4830147768aa8979b` is incorporated into Git history by a retirement merge. Its Supabase-backed operator is deliberately excluded from the current working tree. The user confirmed that Supabase is no longer used and the obsolete implementation may be discarded.

The September implementation loaded Supabase publications, versions, tags and embeddings, then directly applied D1 Search/FTS or Vectorize mutations. Its snapshot rollback could restore whole Search tables. It lacked the current Core generation identity, fencing, tombstones, approved-version guards and guarded repair outbox. Reintroducing those writers would create a bypass of current P0 protections.

Retired additions: `lib/cloudflare/search-materialize/`, `scripts/d1-search-materialize.ts`, its fixture tests, the old operator guide, and the associated package commands. The current migration plan, dependencies and release checks are retained. The original implementation remains retrievable from its historical commit; it is not an enabled production tool or a rollback target.

Current replacements:

- `lib/cloudflare/search-projection/d1-sync.ts`: current eligible immutable P3 projections; protected single/full Search synchronization.
- `lib/cloudflare/e2e/`: durable generation/outbox, CAS/fencing, withdrawal protection and verification evidence.
- `scripts/audit-e2e-p0-production.ts --output-dir=<new-directory>`: read-only current Core/P3–Search/FTS corpus audit.

This integration changes Git history and records retirement. It makes no runtime, database, Worker configuration or production deployment change, and makes no P0 closure claim. Validation compares the integration tree with the latest main, checks that the retired entry points are absent, and verifies that the original commit is an ancestor of the resulting pushed main.
