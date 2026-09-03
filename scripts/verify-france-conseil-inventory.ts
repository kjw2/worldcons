import "dotenv/config";
import { discoverFranceConseilInventory } from "@/lib/crawlee/france-conseil-inventory";
import { franceConseilDocumentType } from "@/lib/backfill/france-scope";

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const year = Number(argumentValue("year") ?? new Date().getUTCFullYear());
  const documentType = franceConseilDocumentType(argumentValue("document-type") ?? "QPC");
  if (!Number.isInteger(year)) throw new Error("invalid_year");
  if (!documentType) throw new Error("invalid_document_type");
  const result = await discoverFranceConseilInventory({ year, documentType });
  process.stdout.write(`${JSON.stringify({
    event: "france_conseil_inventory_verified",
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
    event: "france_conseil_inventory_verification_failed",
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
