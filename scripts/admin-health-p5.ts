import fs from "node:fs/promises";
import { evaluateP5Slas } from "@/lib/admin/p5/evaluator";
import { resolveP5OperationalPolicy } from "@/lib/admin/p5/policy";
import { getP5HealthEvidence } from "@/lib/admin/p5/repository";

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  if (process.env.ADMIN_P5_HEALTH_VERIFICATION_ENABLED?.trim().toLowerCase() !== "true") {
    console.log(JSON.stringify({ schemaVersion: 1, status: "disabled", reason: "feature_flag_disabled" }));
    return 0;
  }
  const policy = resolveP5OperationalPolicy();
  const end = new Date();
  const hours = Math.max(1, Math.min(2160, Number(argument("window-hours") ?? policy.minimumObservationHours)));
  const start = new Date(end.getTime() - hours * 3_600_000);
  const evidence = await getP5HealthEvidence({ observationStart: start.toISOString(), observationEnd: end.toISOString(), policy, now: end });
  const slas = evaluateP5Slas(evidence, policy);
  const hardViolations = slas.filter((item) => item.status === "critical" || item.status === "unknown");
  const report = { schemaVersion: 1, generatedAt: end.toISOString(), available: evidence.available, status: evidence.available && hardViolations.length === 0 ? "passing" : "failing", hardViolationKeys: hardViolations.map((item) => item.key), slas, evidence };
  const output = argument("output");
  if (output) await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ schemaVersion: 1, status: report.status, hardViolationKeys: report.hardViolationKeys, outputWritten: Boolean(output) }));
  return report.status === "passing" ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch(() => {
  console.error(JSON.stringify({ schemaVersion: 1, status: "failing", error: "health_verification_failed" }));
  process.exitCode = 1;
});
