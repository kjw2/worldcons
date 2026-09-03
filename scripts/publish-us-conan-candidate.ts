import "dotenv/config";
import {
  planUsConanCatalogPublication,
  publishUsConanCatalogCandidate,
} from "@/lib/backfill/us-conan-catalog-service";

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
}

function requiredArgument(name: string) {
  const value = argumentValue(name);
  if (!value) throw new Error(`missing_${name}`);
  return value;
}

function integerArgument(name: string) {
  const value = Number(requiredArgument(name));
  if (!Number.isInteger(value) || value < 0) throw new Error(`invalid_${name}`);
  return value;
}

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

function output(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const candidateId = requiredArgument("candidate-id");
  const sourcePolicyVersion = requiredArgument("policy-version");
  if (!flag("execute")) {
    output({ event: "us_conan_catalog_publication_plan", ...await planUsConanCatalogPublication(candidateId, sourcePolicyVersion) });
    return;
  }
  const result = await publishUsConanCatalogCandidate({
    candidateId,
    sourcePolicyVersion,
    expectedReviewRevision: integerArgument("expected-review-revision"),
    expectedCatalogRevision: integerArgument("expected-catalog-revision"),
    idempotencyKey: requiredArgument("idempotency-key"),
    actorId: argumentValue("requested-by") || "us-conan-catalog-cli",
  });
  output({ event: "us_conan_catalog_candidate_published", ...result });
}

main().catch((error) => {
  output({
    event: "us_conan_catalog_publication_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 500) : "unknown_error",
  });
  process.exitCode = 1;
});
