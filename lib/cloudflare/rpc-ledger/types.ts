/**
 * M4.6 RPC ledger types.
 *
 * The ledger is the platform-neutral mapping of every Supabase/Postgres RPC
 * reachable from application source under `app/`, `lib/` and `workers/` to the
 * service operation that will own it after the Cloudflare/D1 migration. It is
 * intentionally free of Supabase/Postgres types so the M5 D1 converter and the
 * M9 Hono services can consume it directly.
 *
 * Every machine-readable ledger row (`RpcLedgerEntry`) carries the migration
 * plan section 6.2 ledger shape - `postgres_function` (`rpcName`),
 * `current_call_sites` (`callSites`), `target_service_method`, `target_db`
 * (`targetDatabase`), `transaction_semantics`, `parity_tests`
 * (`parityEvidence`) and `status` - plus `domain`, `currentPurpose`,
 * `migrationPrimitive`, `risk` and `notes`.
 */

/**
 * Functional domain that owns the function. Typed allowlist so the M5 converter
 * and M9 services can group the ledger by owner.
 */
export const RPC_DOMAINS = [
  "public-reference",
  "article-publication",
  "article-lifecycle",
  "article-raw",
  "case-backfill",
  "search",
  "embeddings",
  "admin-commands",
  "admin-jobs",
  "admin-governance",
  "admin-observability",
  "security",
  "analytics",
  "workflow",
  "tag-maintenance",
] as const;
export type RpcDomain = (typeof RPC_DOMAINS)[number];

/**
 * Owning data target. The four D1 databases use their exact migration/database
 * names (plan section 5). `vectorize` is an explicit typed non-D1 target used
 * where the authoritative store is the Vectorize index rather than a D1
 * database (plan section 6.1: `extensions.vector(1536)` -> Vectorize).
 */
export const RPC_TARGET_DATABASES = [
  "worldcons_core",
  "worldcons_ingest",
  "worldcons_ops",
  "worldcons_search",
  "vectorize",
] as const;
export type RpcTargetDatabase = (typeof RPC_TARGET_DATABASES)[number];
/**
 * Migration primitive/strategy that reproduces the function (plan section 6.2).
 * The atomic primitives are listed first; the remaining values are explicit
 * compound strategies for cross-store coordination.
 */
export const RPC_MIGRATION_PRIMITIVES = [
  "d1-read",
  "d1-transaction",
  "d1-conditional-update",
  "d1-audit-append",
  "d1-projection-publish",
  "d1-search",
  "queue",
  "workflow",
  "r2-coordination",
  "vectorize",
  "durable-object",
  "d1-transaction+queue",
  "d1-transaction+vectorize",
  "d1-transaction+workflow",
  "r2-coordination+d1-transaction",
] as const;
export type RpcMigrationPrimitive = (typeof RPC_MIGRATION_PRIMITIVES)[number];

/** How the function's write, if any, must be reproduced on D1. */
export const RPC_TRANSACTION_SEMANTICS = [
  "read",
  "read-aggregate",
  "search-rank",
  "mutate-transactional",
  "mutate-idempotent",
  "claim-lease",
  "claim-permit",
  "outbox-claim",
  "outbox-settle",
  "audit-append",
  "retention-purge",
  "projection-publish",
] as const;
export type RpcTransactionSemantics = (typeof RPC_TRANSACTION_SEMANTICS)[number];

/** Migration risk of reproducing the function with exact semantics. */
export const RPC_RISKS = ["low", "medium", "high"] as const;
export type RpcRisk = (typeof RPC_RISKS)[number];
/**
 * `mapped` means the function has a target service operation, a target database
 * and at least one existing focused parity test. `pending-parity` means it is
 * mapped but no focused parity test exists yet; in that case
 * `parityEvidence.requiredM5` names the test that must be added.
 */
export const RPC_LEDGER_STATUSES = ["mapped", "pending-parity"] as const;
export type RpcLedgerStatus = (typeof RPC_LEDGER_STATUSES)[number];

/** A concrete `.rpc(` call site, derived from the live scanner/report. */
export interface RpcLedgerCallSiteRef {
  /** Repo-relative POSIX source path. */
  file: string;
  /** 1-based line of the `.rpc(` call. */
  line: number;
}

/**
 * Parity evidence for the mapped service operation. `existing` lists the
 * focused tests that exercise the operation today; `requiredM5` names the
 * explicit M5 D1 parity test that must exist before the RPC is retired
 * (required whenever `existing` is empty).
 */
export interface RpcParityEvidence {
  existing: string[];
  requiredM5: string[];
}

/** The full machine-readable M4.6 ledger row: one row per Postgres function. */
export interface RpcLedgerEntry {
  /** Exact Postgres function name passed to `.rpc(rpcName, ...)`. */
  rpcName: string;
  /** Functional domain that owns the function. */
  domain: RpcDomain;
  /** Concrete call sites, derived from the scanner/report (never empty). */
  callSites: RpcLedgerCallSiteRef[];
  /** What the function does today. */
  currentPurpose: string;
  /** One canonical target service method string. */
  targetServiceMethod: string;
  /** Additional service methods that also own this function (may be empty). */
  additionalServiceMethods: string[];
  /** Owning target database (exact D1 migration name, or a non-D1 target). */
  targetDatabase: RpcTargetDatabase;
  /** Required D1 transaction semantics. */
  transactionSemantics: RpcTransactionSemantics;
  /** Migration primitive/strategy that reproduces the function. */
  migrationPrimitive: RpcMigrationPrimitive;
  /** Existing tests and/or the explicit required M5 parity test. */
  parityEvidence: RpcParityEvidence;
  /** Derived migration status. */
  status: RpcLedgerStatus;
  /** Migration risk of losing semantics. */
  risk: RpcRisk;
  /** Free-form migration notes. */
  notes: string;
}

/** Curated ledger row: the classification without the scan-derived call sites. */
export type RpcLedgerDefinitionEntry = Omit<RpcLedgerEntry, "callSites">;
/**
 * How a `.rpc()` call site's function name was produced.
 *
 * - `literal`       - `rpc("name", ...)`
 * - `constant`      - `rpc(CONST, ...)` where `CONST` is a same-file/imported
 *                     `const` initialized from string literal(s)
 * - `parameter`     - the name is a helper function parameter (finite caller catalog)
 * - `function-call` - the name is the result of a resolver function
 * - `unresolved`    - the scanner could not derive a finite catalog
 */
export type RpcCallSiteKind = "literal" | "constant" | "parameter" | "function-call" | "unresolved";

/** A single `.rpc(` call site discovered by the scanner. */
export interface RpcCallSite {
  /** Repo-relative POSIX path. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** Normalized argument expression text (whitespace collapsed). */
  argText: string;
  kind: RpcCallSiteKind;
  /** Resolved Postgres function names (sorted, deduped); empty when unresolved. */
  names: string[];
  /** Human-readable resolver description for non-literal call sites. */
  resolver: string | null;
}

/**
 * A dynamic indirection: a non-literal call site whose function name is not a
 * direct string literal. When `bounded` is true, `resolvedFunctions` is the
 * finite catalog derived from surrounding code. When `bounded` is false, the
 * indirection is recorded as a dynamic family with its `resolver` and the
 * validator reports it.
 */
export interface RpcLedgerIndirection {
  id: string;
  file: string;
  argText: string;
  kind: Exclude<RpcCallSiteKind, "literal">;
  resolver: string;
  bounded: boolean;
  resolvedFunctions: string[];
}

/** The complete, machine-readable RPC ledger classification. */
export interface RpcLedger {
  version: 1;
  /** Source roots the ledger is authoritative for. */
  scope: string[];
  functions: RpcLedgerDefinitionEntry[];
  indirections: RpcLedgerIndirection[];
}

/** The outcome of cross-checking the ledger against a live source scan. */
export interface RpcLedgerValidation {
  ok: boolean;
  errors: RpcLedgerIssue[];
  warnings: RpcLedgerIssue[];
  callSiteCount: number;
  uniqueFunctionCount: number;
  dynamicCallSiteCount: number;
  unboundedDynamicFamilyCount: number;
}

export interface RpcLedgerIssue {
  code: string;
  message: string;
}