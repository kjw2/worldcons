/**
 * M7.3 ranked-search page LOCAL foundation (code + local verification only).
 *
 * Runtime-safe barrel: it imports no Node builtin, selects no search adapter and
 * performs no remote read or write. Supabase remains the sole search authority.
 * This slice mirrors `worldcons_ranked_search_page_v1` for the exact-case, empty
 * latest and fulltext branches only; semantic/hybrid are deferred, never
 * approximated with lexical search, and Vectorize belongs to a later slice. The
 * local Node `node:sqlite` executor lives only in `tests/` and
 * `scripts/d1-ranked-local.ts`, never here.
 */
export * from "./types";
export * from "./errors";
export * from "./reference";
export * from "./validate";
export * from "./queries";
export * from "./page";
export * from "./reader";
export * from "./parity";
