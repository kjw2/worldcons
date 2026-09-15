import "dotenv/config";
import { discoverFranceDilaConstitInventory } from "@/lib/crawlee/france-dila-constit";
import { franceConseilDocumentType } from "@/lib/backfill/france-scope";
import { HISTORICAL_GATE_MAX_YEAR } from "@/lib/backfill/country-history-policy";

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const defaultYear = Math.min(new Date().getUTCFullYear(), HISTORICAL_GATE_MAX_YEAR);
  const year = Number(argumentValue("year") ?? defaultYear);
  const documentType = franceConseilDocumentType(argumentValue("document-type") ?? "QPC");
  if (!Number.isInteger(year)) throw new Error("invalid_year");
  if (!documentType) throw new Error("invalid_document_type");
  const result = await discoverFranceDilaConstitInventory({ year, documentType });
  process.stdout.write(`${JSON.stringify({
    event: "france_dila_conseil_inventory_verified",
    sourceKey: result.sourceKey,
    year: result.year,
    documentType: result.documentType,
    expectedCount: result.expectedCount,
    discoveredCount: result.items.length,
    pageCount: result.pageCount,
    coverageEvidence: result.coverageEvidence,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    event: "france_dila_conseil_inventory_verification_failed",
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
