/**
 * M7.2 FTS5 lexical full-text foundation (local, code + local verification only).
 *
 * Runtime-safe barrel: it imports no Node builtin, selects no search adapter and
 * performs no remote read or write. Supabase remains the sole search authority.
 * The local Node `node:sqlite` executor lives only in `tests/` and
 * `scripts/d1-fts-local.ts`, never here.
 */
export * from "./types";
export * from "./errors";
export * from "./normalize";
export * from "./title";
export * from "./query-compiler";
export * from "./query";
export * from "./reader";
export * from "./parity";
