/**
 * M7.6 isolated search canary foundation (runtime-neutral).
 *
 * This barrel imports no Node builtin and performs no remote read or write. The
 * operator-only adapters (Wrangler CLI, Supabase reader, parameterized writer)
 * live under `./operator/*` and are deliberately NOT re-exported here, so
 * Worker/runtime code can never load them. Supabase remains the sole production
 * search/read authority and no `GO-SEARCH` / `GO-D1-READ` is claimed.
 */
export * from "./types";
export * from "./manifest";
export * from "./cases";
export * from "./plan";
export * from "./evaluate";
export * from "./oracle";
export * from "./timing";
export * from "./writer";
export * from "./expansion";
export * from "./worker-contract";
export * from "./vector-id";
export * from "./evidence";
