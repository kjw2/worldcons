import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildRpcLedgerReport } from "@/lib/cloudflare/rpc-ledger";

const ARTIFACT_PATH = path.join("artifacts", "cloudflare-m4", "rpc-ledger.json");

/**
 * M4.6 RPC ledger CLI.
 *
 *   pnpm rpc:ledger            validate the ledger against a live source scan
 *   pnpm rpc:ledger --json     print the machine-readable ledger report
 *   pnpm rpc:ledger --write    write the report to artifacts/cloudflare-m4/rpc-ledger.json
 */
function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const write = args.includes("--write");
  const report = buildRpcLedgerReport(process.cwd());

  if (write) {
    fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
    fs.writeFileSync(ARTIFACT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const { validation, generatedFrom } = report;
    console.log(
      `RPC ledger: ${report.functions.length} functions, ${generatedFrom.callSiteCount} call sites, `
      + `${generatedFrom.uniqueFunctionCount} unique functions across ${generatedFrom.files} files`,
    );
    console.log(`kinds: ${JSON.stringify(generatedFrom.byKind)}`);
    console.log(
      `dynamic call sites: ${validation.dynamicCallSiteCount}, unbounded dynamic families: ${validation.unboundedDynamicFamilyCount}`,
    );
    console.log(`adjacent roots (out of scope): ${JSON.stringify(generatedFrom.adjacentCallSiteCounts)}`);
    console.log(`status: mapped ${report.summary.mapped}, pending-parity ${report.summary.pendingParity}; targets: ${JSON.stringify(report.summary.byTargetDatabase)}`);
    if (write) console.log(`wrote ${ARTIFACT_PATH}`);
    for (const warning of validation.warnings) console.log(`warn ${warning.code}: ${warning.message}`);
    for (const error of validation.errors) console.error(`error ${error.code}: ${error.message}`);
    console.log(validation.ok ? "RPC ledger validation: OK" : `RPC ledger validation: FAILED (${validation.errors.length} errors)`);
  }

  if (!report.validation.ok) process.exitCode = 1;
}

main();