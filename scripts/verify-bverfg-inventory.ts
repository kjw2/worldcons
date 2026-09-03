import "dotenv/config";
import { verifyBverfgInventoryReadOnly } from "@/lib/backfill/germany-inventory-verification";

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const year = Number(argumentValue("year") ?? "2024");
  const maxPagesValue = argumentValue("max-pages");
  const maxPages = maxPagesValue === undefined ? undefined : Number(maxPagesValue);
  if (!Number.isInteger(year)) throw new Error("invalid_year");
  if (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500)) {
    throw new Error("invalid_max_pages");
  }
  const report = await verifyBverfgInventoryReadOnly({ year, maxPages });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    event: "bverfg_inventory_read_only_verification_failed",
    error: error instanceof Error ? error.message : String(error),
    productionWriteAuthorized: false,
  })}\n`);
  process.exitCode = 1;
});
