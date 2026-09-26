/**
 * M7.7-B fulltext rank policy foundation (runtime-neutral).
 *
 * This barrel imports no Node builtin and performs no remote read or write. It
 * defines the frozen, content-free representative corpus, the aggregate
 * `compareRankedIds` evidence metrics and the exact-invariant policy state
 * machine. It never invents or tunes a generic lexical numeric threshold:
 * without an independently pre-registered threshold the generic categories stay
 * `insufficient_evidence`. Supabase remains the sole production search/read
 * authority and no `GO-SEARCH` is claimed.
 */
export * from "./types";
export * from "./corpus";
export * from "./metrics";
export * from "./invariants";
export * from "./policy";
export * from "./evidence";
