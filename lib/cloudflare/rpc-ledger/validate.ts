import type { RpcLedger, RpcLedgerDefinitionEntry, RpcLedgerIndirection, RpcLedgerIssue, RpcLedgerValidation } from "./types";
import {
  RPC_DOMAINS,
  RPC_LEDGER_STATUSES,
  RPC_MIGRATION_PRIMITIVES,
  RPC_RISKS,
  RPC_TARGET_DATABASES,
  RPC_TRANSACTION_SEMANTICS,
} from "./types";
import type { RpcLedgerScan } from "./scan";

const DYNAMIC_KINDS = new Set<string>(["parameter", "function-call", "unresolved"]);
const ANCHOR_SEPARATOR = "\u0000";

const DOMAIN_VALUES = new Set<string>(RPC_DOMAINS);
const TARGET_DATABASE_VALUES = new Set<string>(RPC_TARGET_DATABASES);
const MIGRATION_PRIMITIVE_VALUES = new Set<string>(RPC_MIGRATION_PRIMITIVES);
const TRANSACTION_SEMANTICS_VALUES = new Set<string>(RPC_TRANSACTION_SEMANTICS);
const RISK_VALUES = new Set<string>(RPC_RISKS);
const STATUS_VALUES = new Set<string>(RPC_LEDGER_STATUSES);

function anchor(file: string, argText: string): string {
  return `${file}${ANCHOR_SEPARATOR}${argText}`;
}

function issue(code: string, message: string): RpcLedgerIssue {
  return { code, message };
}

function catalog(values: readonly string[]): string {
  return [...values].sort().join(ANCHOR_SEPARATOR);
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/**
 * Validates one curated ledger row's own fields, independent of the scan: every
 * required string is non-empty, every typed classification comes from its exact
 * allowlist, and the parity/status relationship is internally consistent.
 */
function validateDefinitionEntry(entry: RpcLedgerDefinitionEntry, errors: RpcLedgerIssue[]): void {
  const label = entry.rpcName || "<unnamed ledger row>";
  for (const field of ["rpcName", "currentPurpose", "targetServiceMethod", "notes"] as const) {
    if (isBlank(entry[field])) errors.push(issue("empty-ledger-field", `${label} has an empty ${field}`));
  }
  const typedFields: [field: string, described: string, value: unknown, allowed: Set<string>][] = [
    ["domain", "domain", entry.domain, DOMAIN_VALUES],
    ["targetDatabase", "target database", entry.targetDatabase, TARGET_DATABASE_VALUES],
    ["transactionSemantics", "transaction semantics", entry.transactionSemantics, TRANSACTION_SEMANTICS_VALUES],
    ["migrationPrimitive", "migration primitive", entry.migrationPrimitive, MIGRATION_PRIMITIVE_VALUES],
    ["status", "status", entry.status, STATUS_VALUES],
    ["risk", "risk", entry.risk, RISK_VALUES],
  ];
  for (const [field, described, value, allowed] of typedFields) {
    if (isBlank(value)) {
      errors.push(issue("empty-ledger-field", `${label} has an empty ${field}`));
    } else if (!allowed.has(value as string)) {
      errors.push(issue("invalid-ledger-field", `${label} has an unknown ${described} ${String(value)}`));
    }
  }

  entry.additionalServiceMethods.forEach((method, index) => {
    if (isBlank(method)) errors.push(issue("empty-ledger-field", `${label} has an empty additionalServiceMethods[${index}]`));
  });

  const { existing, requiredM5 } = entry.parityEvidence;
  existing.forEach((test, index) => {
    if (isBlank(test)) errors.push(issue("invalid-parity-evidence", `${label} parityEvidence.existing[${index}] is empty`));
  });
  requiredM5.forEach((test, index) => {
    if (isBlank(test)) errors.push(issue("invalid-parity-evidence", `${label} parityEvidence.requiredM5[${index}] is empty`));
  });

  if (entry.status === "mapped" && existing.length < 1) {
    errors.push(issue("invalid-parity-evidence", `${label} is mapped but has no existing parity test`));
  }
  if (entry.status === "pending-parity") {
    if (existing.length !== 0) {
      errors.push(issue("invalid-parity-evidence", `${label} is pending-parity but carries ${existing.length} existing parity test(s)`));
    }
    if (requiredM5.length < 1) {
      errors.push(issue("invalid-parity-evidence", `${label} is pending-parity but declares no required M5 parity test`));
    }
  }
}

/**
 * Cross-checks the curated ledger against a live source scan. Fails (errors)
 * when a ledger row carries an empty required field, an out-of-allowlist typed
 * classification, an inconsistent parity/status relationship, no scanner-
 * resolved call site, a reachable RPC has no ledger entry, a dynamic call site
 * is unclassified, a declared catalog drifts from the scanner, or the ledger
 * carries a stale entry. Unbounded dynamic families are recorded and counted.
 */
export function validateRpcLedger(ledger: RpcLedger, scan: RpcLedgerScan): RpcLedgerValidation {
  const errors: RpcLedgerIssue[] = [];
  const warnings: RpcLedgerIssue[] = [];

  const functions = new Map<string, RpcLedgerDefinitionEntry>();
  for (const entry of ledger.functions) {
    if (functions.has(entry.rpcName)) {
      errors.push(issue("duplicate-ledger-function", `ledger declares ${entry.rpcName} more than once`));
    }
    functions.set(entry.rpcName, entry);
    validateDefinitionEntry(entry, errors);
  }

  const scannedNames = new Set<string>();
  const resolvedCallSiteCounts = new Map<string, number>();
  for (const site of scan.callSites) {
    for (const name of site.names) {
      scannedNames.add(name);
      resolvedCallSiteCounts.set(name, (resolvedCallSiteCounts.get(name) ?? 0) + 1);
    }
  }

  for (const name of [...scannedNames].sort()) {
    if (!functions.has(name)) {
      errors.push(issue("unmapped-function", `a call site resolves to ${name} but the ledger has no entry`));
    }
  }
  for (const entry of ledger.functions) {
    if (!scannedNames.has(entry.rpcName)) {
      errors.push(issue("orphan-ledger-function", `ledger entry ${entry.rpcName} has no reachable call site`));
    }
    if ((resolvedCallSiteCounts.get(entry.rpcName) ?? 0) < 1) {
      errors.push(issue("ledger-function-without-call-site", `ledger entry ${entry.rpcName} has no scanner-resolved .rpc( call site`));
    }
  }
  for (const site of scan.callSites) {
    if (site.names.length === 0) {
      errors.push(issue("unresolved-call-site", `${site.file}:${site.line} .rpc(${site.argText}) produced no function name`));
    }
  }

  const indirections = new Map<string, RpcLedgerIndirection>();
  for (const indirection of ledger.indirections) {
    const key = anchor(indirection.file, indirection.argText);
    if (indirections.has(key)) {
      errors.push(issue("duplicate-indirection", `ledger declares indirection ${indirection.id} more than once`));
    }
    indirections.set(key, indirection);
    for (const name of indirection.resolvedFunctions) {
      if (!functions.has(name)) {
        errors.push(issue("unknown-indirection-function", `${indirection.id} references ${name}, which is not in the ledger`));
      }
    }
    if (!indirection.bounded && indirection.resolver.trim().length === 0) {
      errors.push(issue("unbounded-without-resolver", `${indirection.id} is unbounded but carries no resolver`));
    }
    if (indirection.bounded && indirection.resolvedFunctions.length === 0) {
      warnings.push(issue("bounded-with-empty-catalog", `${indirection.id} is bounded but declares no functions`));
    }
  }

  let dynamicCallSiteCount = 0;
  let unboundedDynamicFamilyCount = 0;
  for (const site of scan.callSites) {
    if (site.kind === "literal") continue;
    const key = anchor(site.file, site.argText);
    const indirection = indirections.get(key);
    if (!indirection) {
      errors.push(issue("unclassified-call-site", `${site.file}:${site.line} .rpc(${site.argText}) [${site.kind}] is not covered by a ledger indirection`));
      continue;
    }
    if (DYNAMIC_KINDS.has(site.kind)) {
      dynamicCallSiteCount += 1;
      if (!indirection.bounded) unboundedDynamicFamilyCount += 1;
    }
    if (indirection.kind !== site.kind) {
      warnings.push(issue("indirection-kind-drift", `${site.file}:${site.line} scanner kind ${site.kind} differs from ledger kind ${indirection.kind}`));
    }
    if (indirection.bounded && catalog(site.names) !== catalog(indirection.resolvedFunctions)) {
      errors.push(issue("indirection-catalog-mismatch", `${site.file}:${site.line} scanner resolved [${site.names.join(", ")}] but ledger declares [${indirection.resolvedFunctions.join(", ")}]`));
    }
  }
  const scannedAnchors = new Set(
    scan.callSites.filter((site) => site.kind !== "literal").map((site) => anchor(site.file, site.argText)),
  );
  for (const indirection of ledger.indirections) {
    if (!scannedAnchors.has(anchor(indirection.file, indirection.argText))) {
      errors.push(issue("orphan-indirection", `${indirection.id} has no matching non-literal call site (${indirection.file} .rpc(${indirection.argText}))`));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    callSiteCount: scan.callSites.length,
    uniqueFunctionCount: scan.uniqueFunctions.length,
    dynamicCallSiteCount,
    unboundedDynamicFamilyCount,
  };
}