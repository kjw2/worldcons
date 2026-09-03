import "dotenv/config";
import { verifyBverfgPrivateShadowCanary } from "@/lib/backfill/germany-shadow-canary";

function argumentValue(name: string) {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
}

async function main() {
  const snapshotId = argumentValue("snapshot");
  if (!snapshotId) throw new Error("missing_snapshot");
  const result = await verifyBverfgPrivateShadowCanary(snapshotId);
  process.stdout.write(`${JSON.stringify({ event: "bverfg_private_shadow_canary_verified", ...result })}\n`);
  if (result.status !== "pass") process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    event: "bverfg_private_shadow_canary_failed",
    errorCode: error instanceof Error ? error.message.slice(0, 500) : "unknown_error",
    readOnly: true,
    productionWriteAuthorizedByThisCheck: false,
  })}\n`);
  process.exitCode = 1;
});
