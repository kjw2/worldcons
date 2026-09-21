import type {
  RpcCallSite,
  RpcLedger,
  RpcLedgerCallSiteRef,
  RpcLedgerEntry,
  RpcLedgerValidation,
  RpcTargetDatabase,
} from "./types";
import { rpcLedger } from "./ledger";
import { scanRpcLedgerSources, type RpcLedgerScan } from "./scan";
import { validateRpcLedger } from "./validate";

export * from "./types";
export { rpcLedger, rpcLedgerFunctions, rpcLedgerIndirections } from "./ledger";
export { scanRpcLedgerSources, DEFAULT_SCAN_ROOTS, ADJACENT_SCAN_ROOTS } from "./scan";
export type { RpcLedgerScan } from "./scan";
export { validateRpcLedger } from "./validate";

/** Summary counts over the machine-readable ledger rows. */
export interface RpcLedgerReportSummary {
  mapped: number;
  pendingParity: number;
  byTargetDatabase: Record<RpcTargetDatabase, number>;
}

/** The machine-readable ledger artifact: enriched rows + evidence + validation. */
export interface RpcLedgerReport {
  version: 1;
  scope: string[];
  generatedFrom: {
    files: number;
    callSiteCount: number;
    uniqueFunctionCount: number;
    byKind: RpcLedgerScan["byKind"];
    adjacentCallSiteCounts: Record<string, number>;
  };
  summary: RpcLedgerReportSummary;
  functions: RpcLedgerEntry[];
  indirections: RpcLedger["indirections"];
  validation: RpcLedgerValidation;
}

export function summarizeRpcLedgerReport(functions: readonly RpcLedgerEntry[]): RpcLedgerReportSummary {
  const byTargetDatabase: Record<RpcTargetDatabase, number> = {
    worldcons_core: 0,
    worldcons_ingest: 0,
    worldcons_ops: 0,
    worldcons_search: 0,
    vectorize: 0,
  };
  let mapped = 0;
  let pendingParity = 0;
  for (const entry of functions) {
    byTargetDatabase[entry.targetDatabase] += 1;
    if (entry.status === "mapped") mapped += 1;
    else pendingParity += 1;
  }
  return { mapped, pendingParity, byTargetDatabase };
}

function callSiteRef(site: RpcCallSite): RpcLedgerCallSiteRef {
  return { file: site.file, line: site.line };
}

/**
 * Builds the machine-readable report consumed by `scripts/rpc-ledger.ts`. The
 * call-site evidence is derived from the live scan, so it cannot drift from the
 * source tree; the curated classification comes from `ledger.ts`.
 */
export function buildRpcLedgerReport(rootDir: string): RpcLedgerReport {
  const scan = scanRpcLedgerSources({ rootDir });
  const validation = validateRpcLedger(rpcLedger, scan);
  const byName = new Map<string, RpcLedgerCallSiteRef[]>();
  for (const site of scan.callSites) {
    for (const name of site.names) {
      const list = byName.get(name) ?? [];
      list.push(callSiteRef(site));
      byName.set(name, list);
    }
  }
  const functions: RpcLedgerEntry[] = rpcLedger.functions.map((definition) => ({
    rpcName: definition.rpcName,
    domain: definition.domain,
    callSites: (byName.get(definition.rpcName) ?? [])
      .slice()
      .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line),
    currentPurpose: definition.currentPurpose,
    targetServiceMethod: definition.targetServiceMethod,
    additionalServiceMethods: [...definition.additionalServiceMethods],
    targetDatabase: definition.targetDatabase,
    transactionSemantics: definition.transactionSemantics,
    migrationPrimitive: definition.migrationPrimitive,
    parityEvidence: {
      existing: [...definition.parityEvidence.existing],
      requiredM5: [...definition.parityEvidence.requiredM5],
    },
    status: definition.status,
    risk: definition.risk,
    notes: definition.notes,
  }));
  return {
    version: 1,
    scope: rpcLedger.scope,
    generatedFrom: {
      files: scan.files,
      callSiteCount: scan.callSites.length,
      uniqueFunctionCount: scan.uniqueFunctions.length,
      byKind: scan.byKind,
      adjacentCallSiteCounts: scan.adjacentCallSiteCounts,
    },
    summary: summarizeRpcLedgerReport(functions),
    functions,
    indirections: rpcLedger.indirections,
    validation,
  };
}