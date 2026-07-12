import { evaluateP5RetirementReadiness, P5_RETIREMENT_FLAG_ORDER } from "@/lib/admin/p5/evaluator";
import { resolveP5OperationalPolicy } from "@/lib/admin/p5/policy";
import { getP5HealthEvidence } from "@/lib/admin/p5/repository";

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const observationStart = argument("observation-start");
  const observationEnd = argument("observation-end");
  if (!observationStart || !observationEnd) {
    console.error(JSON.stringify({ status: "blocked", error: "explicit_observation_window_required" }));
    return 2;
  }
  const start = new Date(observationStart);
  const end = new Date(observationEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    console.error(JSON.stringify({ status: "blocked", error: "invalid_observation_window" }));
    return 2;
  }
  const policy = resolveP5OperationalPolicy();
  const evidence = await getP5HealthEvidence({ observationStart: start.toISOString(), observationEnd: end.toISOString(), policy });
  const flags = Object.fromEntries(P5_RETIREMENT_FLAG_ORDER.map(([name]) => [name, process.env[name]?.trim().toLowerCase() === "true"]));
  const observationSampleRate = Number(process.env.ADMIN_P5_COMPATIBILITY_OBSERVATION_SAMPLE_RATE ?? "0");
  const report = evaluateP5RetirementReadiness({ evidence, policy, observationStart: start.toISOString(), observationEnd: end.toISOString(), flags, observationSampleRate, signingKey: process.env.ADMIN_P5_REPORT_SIGNING_KEY });
  console.log(JSON.stringify(report, null, 2));
  return report.ready ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch(() => {
  console.error(JSON.stringify({ status: "blocked", error: "readiness_evaluation_failed" }));
  process.exitCode = 2;
});
