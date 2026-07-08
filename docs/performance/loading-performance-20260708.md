# Loading Performance Pass - 2026-07-08

## Scope

This pass targeted slow first paint, slow article navigation, and expensive list/filter movement on the public World Cons pages.

## Implemented Changes

1. Added `public_jurisdiction_article_counts(range_start)` and a partial public-count index so jurisdiction counts can be loaded with one grouped query.
2. Updated `listJurisdictionArticleCounts()` to use the grouped RPC first and fall back to the previous per-jurisdiction count path if the migration is not applied.
3. Removed the extra `listSources()` round trip from `/api/home/range`.
4. Added `getArticleDetailPageData()` and optimized related article lookup to use the already-loaded tag id before falling back to tag slug lookup.
5. Added short-lived function/API caching for public article list, article detail, and source-text API reads.
6. Removed the public detail page's automatic admin review API load. Admin review remains available at `/admin/articles/[slug]`.
7. Moved the home filter bar and time range tabs back to server-rendered links. The client boundary now starts at the infinite feed instead of wrapping the whole home filter/feed panel.
8. Replaced full article-array sessionStorage snapshots with lightweight return-state snapshots. Loaded pages are reconstructed from the cached API when needed.
9. Disabled route prefetching for high-cardinality public list/filter links to avoid unnecessary route prefetch traffic during first screen interaction.

## Database Migration

Apply `supabase/migrations/20260708090000_public_jurisdiction_article_counts.sql` before relying on the grouped count path in production. The application has a fallback path, but the first-screen count improvement depends on this migration.

## Verification

Required local checks:

```bash
pnpm exec tsc --noEmit
pnpm check
pnpm lint
pnpm build
git diff --check
```

Recommended API smoke after build/start:

```bash
curl -i "http://localhost:3010/api/home/range?pageSize=9"
curl -i "http://localhost:3010/api/articles?page=2&pageSize=9&count=none"
curl -i "http://localhost:3010/api/articles/{slug}"
curl -i "http://localhost:3010/api/articles/{slug}/source-text"
```

Production checks:

- Compare Vercel function duration for `/`, `/list`, `/api/home/range`, and `/articles/[slug]` before/after deployment.
- Confirm `/api/home/range` no longer performs a source-list query solely for jurisdiction counts.
- Confirm Supabase slow query logs no longer show fan-out exact count queries per jurisdiction on first-screen range changes.
- Confirm browser Network panel no longer shows automatic admin review API calls on public article detail pages.
- Confirm list/detail/back navigation restores position without storing large article arrays in `sessionStorage`.

## Local Verification Result

Completed on 2026-07-08 KST:

- `pnpm exec tsc --noEmit`: pass
- `pnpm check`: pass
- `pnpm lint`: pass
- `pnpm build`: pass
- `git diff --check`: pass
- Local production API smoke on `localhost:3010`:
  - `/api/home/range?pageSize=9`: 200
  - `/api/articles?page=2&pageSize=9&count=none`: 200
  - `/api/articles/france-fr-conseil-constitutionnel-2026-07-03-decision-n-2026-1212-qpc-du-3-juillet-2026-3fc5b6`: 200
  - `/api/articles/france-fr-conseil-constitutionnel-2026-07-03-decision-n-2026-1212-qpc-du-3-juillet-2026-3fc5b6/source-text`: 200

Observed `next build` route JS changes after moving the home/list filter shell out of the client boundary:

- `/`: `326 B` route size, `134 kB` first load JS
- `/list`: `618 B` route size, `106 kB` first load JS
- `/articles/[slug]`: `2.72 kB` route size, `109 kB` first load JS
