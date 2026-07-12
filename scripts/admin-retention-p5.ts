import "dotenv/config";
import { resolveP5OperationalPolicy } from "@/lib/admin/p5/policy";
import { applyP5Retention, getP5HealthEvidence } from "@/lib/admin/p5/repository";

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const now = new Date();
  const policy = resolveP5OperationalPolicy();
  const observationStart = new Date(now.getTime() - policy.minimumObservationHours * 3_600_000).toISOString();
  const evidence = await getP5HealthEvidence({ observationStart, observationEnd: now.toISOString(), now, policy });
  const apply = process.argv.includes("--apply");
  if (!apply) {
    console.log(JSON.stringify({ schemaVersion: 1, mode: "dry-run", available: evidence.available, retention: evidence.retention, immutablePolicy: "archive_authoritative_ledgers" }, null, 2));
    return evidence.available ? 0 : 1;
  }
  const confirmation = argument("confirm") ?? "";
  if (confirmation !== "APPLY P5 RETENTION") {
    console.error(JSON.stringify({ status: "blocked", error: "typed_confirmation_required", expected: "APPLY P5 RETENTION" }));
    return 2;
  }
  const result = await applyP5Retention({
    observationBefore: new Date(now.getTime() - policy.retention.compatibilityObservationDays * 86_400_000).toISOString(),
    deliveredOutboxBefore: new Date(now.getTime() - policy.retention.deliveredOutboxDays * 86_400_000).toISOString(),
    batchSize: policy.retention.batchSize,
    confirmation,
  });
  console.log(JSON.stringify({ schemaVersion: 1, mode: "apply", ...result }, null, 2));
  return result.ok ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch(() => {
  console.error(JSON.stringify({ status: "blocked", error: "retention_operation_failed" }));
  process.exitCode = 2;
});
