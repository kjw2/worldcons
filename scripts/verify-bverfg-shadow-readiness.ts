import "dotenv/config";
import { verifyBverfgPrivateShadowReadiness } from "@/lib/backfill/germany-shadow-readiness";

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
}

async function main() {
  const year = Number(argumentValue("year") ?? "2024");
  const policyVersion = argumentValue("policy-version");
  if (!Number.isInteger(year)) throw new Error("invalid_year");
  if (!policyVersion) throw new Error("missing_policy-version");
  const result = await verifyBverfgPrivateShadowReadiness({ year, policyVersion });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "blocked") process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    event: "bverfg_private_shadow_readiness_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 500) : "unknown_error",
    readOnly: true,
    productionWriteAuthorizedByThisCheck: false,
  })}\n`);
  process.exitCode = 1;
});
