/**
 * M7.8-A semantic-authority rollout (code/local verification only).
 *
 * Operator-only runtime-neutral modules that pin the exact forward M7.7-A
 * migration, inventory the remote migration ledger, author the read-only
 * preflight, build the `supabase db query --linked` apply plan, resolve the
 * bounded post-apply semantic/hybrid smoke through the M7.6 oracle seam and
 * define the content-free evidence contract.
 *
 * Nothing here selects a production search adapter or mutates Supabase. The
 * apply path is never invoked by importing this barrel; only the operator script
 * can run it, and only with the explicit `--apply` flag after an in-process
 * preflight.
 */
export * from "./migration-contract";
export * from "./migration-inventory";
export * from "./preflight-sql";
export * from "./apply-plan";
export * from "./migration-repair";
export * from "./smoke";
export * from "./finalize-existing";
export * from "./evidence";
