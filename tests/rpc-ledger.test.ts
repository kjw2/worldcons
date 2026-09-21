import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRpcLedgerReport,
  rpcLedger,
  scanRpcLedgerSources,
  validateRpcLedger,
} from "../lib/cloudflare/rpc-ledger";
import type { RpcCallSite, RpcLedger, RpcLedgerDefinitionEntry, RpcLedgerEntry, RpcLedgerScan } from "../lib/cloudflare/rpc-ledger";

const rootDir = process.cwd();

const DOMAINS = [
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
];

const TARGET_DATABASES = ["worldcons_core", "worldcons_ingest", "worldcons_ops", "worldcons_search", "vectorize"];
const RISKS = ["low", "medium", "high"];
const STATUSES = ["mapped", "pending-parity"];
const SEMANTICS = [
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
];
const PRIMITIVES = [
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
];

function withExtraCallSites(scan: RpcLedgerScan, extra: RpcCallSite[]): RpcLedgerScan {
  const names = new Set(scan.uniqueFunctions);
  for (const site of extra) for (const name of site.names) names.add(name);
  return { ...scan, callSites: [...scan.callSites, ...extra], uniqueFunctions: [...names].sort() };
}

function site(kind: RpcCallSite["kind"], argText: string, names: string[]): RpcCallSite {
  return { file: "lib/synthetic/probe.ts", line: 7, column: 3, argText, kind, names, resolver: "synthetic" };
}

function withFirstFunction(ledger: RpcLedger, patch: Partial<RpcLedgerDefinitionEntry>): RpcLedger {
  return {
    ...ledger,
    functions: ledger.functions.map((entry, index) => (index === 0 ? { ...entry, ...patch } : entry)),
  };
}
test("scanner is complete and reproducible over the M4.6 scope", () => {
  const scan = scanRpcLedgerSources({ rootDir });

  assert.deepEqual(scan.roots, ["app", "lib", "workers"]);
  assert.equal(scan.callSites.length, 74, "the ledger scope must contain exactly 74 .rpc( call sites");
  assert.equal(scan.uniqueFunctions.length, 80, "the 74 call sites must resolve to 80 unique Postgres functions");
  assert.deepEqual(scan.byKind, { literal: 62, constant: 10, parameter: 1, "function-call": 1, unresolved: 0 });
  assert.equal(scan.adjacentCallSiteCounts.scripts, 7, "operator-script RPCs are counted as a documented out-of-scope root");
  assert.equal(scan.adjacentCallSiteCounts.components, 0);
  assert.equal(scan.adjacentCallSiteCounts.plugins, 0);
  assert.equal(scan.adjacentCallSiteCounts.worker, 0);

  for (const callSite of scan.callSites) {
    assert.ok(callSite.names.length > 0, `${callSite.file}:${callSite.line} must resolve to at least one function`);
  }
  assert.equal(new Set(scan.callSites.map((callSite) => callSite.file)).size, 30, "the ledger scope must cover 30 coupling files");
});

test("the ledger validates against the live scan", () => {
  const scan = scanRpcLedgerSources({ rootDir });
  const validation = validateRpcLedger(rpcLedger, scan);

  assert.deepEqual(validation.errors, []);
  assert.equal(validation.ok, true);
  assert.equal(validation.callSiteCount, 74);
  assert.equal(validation.uniqueFunctionCount, 80);
  assert.equal(validation.dynamicCallSiteCount, 2);
  assert.equal(validation.unboundedDynamicFamilyCount, 0);
  assert.equal(rpcLedger.functions.length, 80, "one ledger row per Postgres function");
  assert.equal(rpcLedger.indirections.length, 12, "one indirection entry per non-literal call site");
});
test("command-control-plane indirections resolve to their finite catalogs", () => {
  const scan = scanRpcLedgerSources({ rootDir });
  const sites = scan.callSites.filter((callSite) => callSite.file.endsWith("admin/command-control-plane/repository.ts"));

  const wrapper = sites.find((callSite) => callSite.argText === "name");
  assert.ok(wrapper, "the local rpc(name, args) wrapper call site must be found");
  assert.equal(wrapper.kind, "parameter");
  assert.deepEqual(wrapper.names, [
    "admin_abort_command_run_v3",
    "admin_complete_command_attempt_v3",
    "admin_fail_command_attempt_v3",
    "admin_heartbeat_command_attempt_v3",
    "admin_retry_command_run_v3",
    "admin_submit_command_v3",
  ]);

  const claim = sites.find((callSite) => callSite.argText === "rpcName");
  assert.ok(claim, "the claim() rpcName ternary call site must be found");
  assert.equal(claim.kind, "constant");
  assert.deepEqual(claim.names, ["admin_claim_command_attempt_p1", "admin_claim_command_attempt_v3"]);
});

test("the vector-match resolver resolves through the article-publication barrel", () => {
  const scan = scanRpcLedgerSources({ rootDir });
  const callSite = scan.callSites.find((entry) => entry.argText.startsWith("publicVectorMatchRpc("));

  assert.ok(callSite, "the publicVectorMatchRpc(...) call site must be found");
  assert.equal(callSite.kind, "function-call");
  assert.deepEqual(callSite.names, ["match_articles", "match_public_article_versions_p3"]);
});

test("same-file constants resolve to their literal catalogs", () => {
  const scan = scanRpcLedgerSources({ rootDir });

  const countRpc = scan.callSites.find((entry) => entry.argText === "countRpc");
  assert.ok(countRpc, "the jurisdiction-count constant call site must be found");
  assert.equal(countRpc.kind, "constant");
  assert.deepEqual(countRpc.names, ["public_jurisdiction_article_counts", "public_jurisdiction_article_counts_p3"]);

  const rankedPage = scan.callSites.find((entry) => entry.argText === "RANKED_SEARCH_PAGE_RPC");
  assert.ok(rankedPage);
  assert.equal(rankedPage.kind, "constant");
  assert.deepEqual(rankedPage.names, ["worldcons_ranked_search_page_v1"]);
});
test("the validator flags an unclassified dynamic call site", () => {
  const scan = scanRpcLedgerSources({ rootDir });
  const injected = withExtraCallSites(scan, [site("function-call", "pickRpc()", ["admin_submit_command_v3"])]);
  const validation = validateRpcLedger(rpcLedger, injected);

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((entry) => entry.code === "unclassified-call-site"));
});

test("the validator flags a reachable function with no ledger entry", () => {
  const scan = scanRpcLedgerSources({ rootDir });
  const injected = withExtraCallSites(scan, [site("literal", "\"ghost_rpc_v9\"", ["ghost_rpc_v9"])]);
  const validation = validateRpcLedger(rpcLedger, injected);

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((entry) => entry.code === "unmapped-function"));
});

test("the validator flags a dynamic catalog that drifts from the scanner", () => {
  const scan = scanRpcLedgerSources({ rootDir });
  const drifted: RpcLedger = {
    ...rpcLedger,
    indirections: rpcLedger.indirections.map((indirection) => (
      indirection.id === "search-vector-match-authority"
        ? { ...indirection, resolvedFunctions: ["match_articles"] }
        : indirection
    )),
  };
  const validation = validateRpcLedger(drifted, scan);

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((entry) => entry.code === "indirection-catalog-mismatch"));
});

test("an unbounded dynamic family is recorded and counted, not failed", () => {
  const scan = scanRpcLedgerSources({ rootDir });
  const unbounded: RpcLedger = {
    ...rpcLedger,
    indirections: rpcLedger.indirections.map((indirection) => (
      indirection.id === "command-control-plane-local-rpc-wrapper"
        ? { ...indirection, bounded: false, resolvedFunctions: [] }
        : indirection
    )),
  };
  const validation = validateRpcLedger(unbounded, scan);

  assert.equal(validation.ok, true);
  assert.equal(validation.unboundedDynamicFamilyCount, 1);
  assert.equal(validation.dynamicCallSiteCount, 2);
});
test("the machine-readable report carries every required M4.6 field on all 80 rows", () => {
  const report = buildRpcLedgerReport(rootDir);

  assert.equal(report.version, 1);
  assert.equal(report.functions.length, 80);
  assert.equal(report.generatedFrom.callSiteCount, 74);
  assert.equal(report.generatedFrom.uniqueFunctionCount, 80);
  assert.equal(report.validation.ok, true);

  const entries: RpcLedgerEntry[] = report.functions;
  const names = new Set<string>();
  for (const entry of entries) {
    assert.ok(entry.rpcName.length > 0);
    assert.ok(!names.has(entry.rpcName), `${entry.rpcName} must be unique`);
    names.add(entry.rpcName);

    assert.ok(entry.callSites.length >= 1, `${entry.rpcName} must carry at least one call site`);
    for (const ref of entry.callSites) {
      assert.ok(ref.file.length > 0, `${entry.rpcName} call site file must be non-empty`);
      assert.ok(Number.isInteger(ref.line) && ref.line >= 1, `${entry.rpcName} call site line must be >= 1`);
    }

    assert.ok(DOMAINS.includes(entry.domain), `${entry.rpcName} has an unknown domain ${entry.domain}`);
    assert.ok(entry.currentPurpose.length > 0);
    assert.ok(entry.targetServiceMethod.length > 0);
    assert.ok(Array.isArray(entry.additionalServiceMethods));
    assert.ok(TARGET_DATABASES.includes(entry.targetDatabase), `${entry.rpcName} has an unknown target ${entry.targetDatabase}`);
    assert.ok(SEMANTICS.includes(entry.transactionSemantics), `${entry.rpcName} has unknown semantics ${entry.transactionSemantics}`);
    assert.ok(PRIMITIVES.includes(entry.migrationPrimitive), `${entry.rpcName} has an unknown primitive ${entry.migrationPrimitive}`);
    assert.ok(STATUSES.includes(entry.status), `${entry.rpcName} has an unknown status ${entry.status}`);
    assert.ok(RISKS.includes(entry.risk), `${entry.rpcName} has an unknown risk ${entry.risk}`);
    assert.ok(entry.notes.length > 0);
    assert.ok(Array.isArray(entry.parityEvidence.existing));
    assert.ok(Array.isArray(entry.parityEvidence.requiredM5));
    if (entry.status === "mapped") {
      assert.ok(entry.parityEvidence.existing.length >= 1, `${entry.rpcName} is mapped but has no parity test`);
    } else {
      assert.equal(entry.parityEvidence.existing.length, 0);
      assert.ok(entry.parityEvidence.requiredM5.length >= 1, `${entry.rpcName} is pending-parity without a required M5 test`);
    }
  }
});
test("the report summary exposes typed target databases and serializes the required fields", () => {
  const report = buildRpcLedgerReport(rootDir);

  assert.equal(report.summary.mapped + report.summary.pendingParity, 80);
  const summed = Object.values(report.summary.byTargetDatabase).reduce((total, count) => total + count, 0);
  assert.equal(summed, 80);
  assert.equal(report.summary.byTargetDatabase.vectorize, 2, "the two vector-match RPCs use the non-D1 Vectorize target");
  for (const database of ["worldcons_core", "worldcons_ingest", "worldcons_ops", "worldcons_search"] as const) {
    assert.ok(report.summary.byTargetDatabase[database] > 0, `${database} must own at least one RPC`);
  }

  const requiredFields = [
    "rpcName",
    "domain",
    "callSites",
    "currentPurpose",
    "targetServiceMethod",
    "additionalServiceMethods",
    "targetDatabase",
    "transactionSemantics",
    "migrationPrimitive",
    "parityEvidence",
    "status",
    "risk",
    "notes",
  ];
  const roundTripped = JSON.parse(JSON.stringify(report)) as typeof report;
  assert.equal(roundTripped.functions.length, 80);
  assert.equal(roundTripped.indirections.length, 12);
  assert.equal(roundTripped.validation.ok, true);
  for (const entry of roundTripped.functions) {
    for (const field of requiredFields) {
      assert.ok(Object.prototype.hasOwnProperty.call(entry, field), `${field} must be serialized directly on every row`);
    }
    assert.ok(Object.prototype.hasOwnProperty.call(entry.parityEvidence, "existing"));
    assert.ok(Object.prototype.hasOwnProperty.call(entry.parityEvidence, "requiredM5"));
    assert.ok(entry.callSites.length >= 1);
  }
});

test("the validator itself rejects a ledger row with an empty currentPurpose", () => {
  const scan = scanRpcLedgerSources({ rootDir });
  const validation = validateRpcLedger(withFirstFunction(rpcLedger, { currentPurpose: "" }), scan);

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((entry) => entry.code === "empty-ledger-field" && entry.message.includes("currentPurpose")));
});

test("the validator itself rejects a target database outside the typed allowlist", () => {
  const scan = scanRpcLedgerSources({ rootDir });
  const injected = "mysql" as unknown as RpcLedgerDefinitionEntry["targetDatabase"];
  const validation = validateRpcLedger(withFirstFunction(rpcLedger, { targetDatabase: injected }), scan);

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((entry) => entry.code === "invalid-ledger-field" && entry.message.includes("target database")));
});

test("the validator itself rejects an empty migrationPrimitive", () => {
  const scan = scanRpcLedgerSources({ rootDir });
  const injected = "" as unknown as RpcLedgerDefinitionEntry["migrationPrimitive"];
  const validation = validateRpcLedger(withFirstFunction(rpcLedger, { migrationPrimitive: injected }), scan);

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((entry) => entry.code === "empty-ledger-field" && entry.message.includes("migrationPrimitive")));
});

test("the validator itself rejects empty notes", () => {
  const scan = scanRpcLedgerSources({ rootDir });
  const validation = validateRpcLedger(withFirstFunction(rpcLedger, { notes: "" }), scan);

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((entry) => entry.code === "empty-ledger-field" && entry.message.includes("notes")));
});

test("the validator itself rejects a mapped row with no existing parity evidence", () => {
  const scan = scanRpcLedgerSources({ rootDir });
  const mutated = withFirstFunction(rpcLedger, { status: "mapped", parityEvidence: { existing: [], requiredM5: [] } });
  const validation = validateRpcLedger(mutated, scan);

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((entry) => entry.code === "invalid-parity-evidence" && entry.message.includes("mapped but has no existing parity test")));
});