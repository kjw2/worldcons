/**
 * Stage/Workflow search projection sync — re-export shim.
 *
 * The implementation moved to `@/lib/cloudflare/search-projection/d1-sync` so
 * both the `worldcons` Worker's `WorldconsOpsService` (per-article staged
 * projection) and the `worldcons-ingest` Worker (full M8 scan) share one
 * authoritative module. This shim preserves the existing import paths.
 */
export * from "../../../lib/cloudflare/search-projection/d1-sync";
