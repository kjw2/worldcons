/**
 * M7.5 remote search canary / parity evidence foundation (runtime-neutral).
 *
 * This barrel imports no Node builtin and performs no remote read or write. The
 * operator-only Wrangler adapters live under `./operator/*` and are deliberately
 * NOT re-exported here, so Worker/runtime code can never load them. Supabase
 * remains the sole production search/read authority and no `GO-SEARCH` /
 * `GO-D1-READ` is claimed.
 */
export * from "./types";
export * from "./manifest";
export * from "./cases";
export * from "./plan";
export * from "./evaluate";
export * from "./evidence";
