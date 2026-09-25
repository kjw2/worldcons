/**
 * M7.4 Vectorize semantic + hybrid LOCAL foundation (code + local verification only).
 *
 * Runtime-safe barrel: it imports no Node builtin, no `@cloudflare` type, selects
 * no search adapter and performs no remote read or write. Supabase remains the
 * sole production search authority and `search_m7` stays a blocker. The local
 * `node:sqlite` executor lives only in `tests/` and `scripts/d1-hybrid-local.ts`;
 * the structural Vectorize binding is satisfied by an injected real Worker
 * binding or a deterministic in-memory fake.
 */
export * from "./types";
export * from "./errors";
export * from "./embedding";
export * from "./metadata";
export * from "./projection";
export * from "./semantic";
export * from "./hybrid";
export * from "./ranked";
