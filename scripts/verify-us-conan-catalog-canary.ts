import "dotenv/config";
import { verifyUsConanCatalogCanary } from "@/lib/backfill/us-conan-canary-service";

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
}

async function main() {
  const candidateId = argumentValue("candidate-id");
  if (!candidateId) throw new Error("missing_candidate-id");
  const result = await verifyUsConanCatalogCanary(candidateId);
  process.stdout.write(`${JSON.stringify({ event: "us_conan_catalog_canary_verified", ...result })}\n`);
  if (result.status !== "pass") process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    event: "us_conan_catalog_canary_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 500) : "unknown_error",
  })}\n`);
  process.exitCode = 1;
});
