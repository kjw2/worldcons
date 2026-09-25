/**
 * M7.1 search projection foundation (local, code-only).
 *
 * This barrel is runtime-safe: it imports no Node builtin and no Cloudflare
 * binding. It never executes a remote read or write. The operator CLI
 * (`scripts/d1-search-projection.ts`) is the only place allowed `node:*`.
 */
export * from "./types";
export * from "./errors";
export * from "./canonical";
export * from "./checksum";
export * from "./documents";
export * from "./fts-document";
export * from "./source";
export * from "./build";
export * from "./plan";
export * from "./verify";
