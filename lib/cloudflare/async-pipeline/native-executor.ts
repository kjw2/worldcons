import { getP5HealthEvidenceFromD1 } from "@/lib/admin/p5/d1-health-repository";
import { evaluateP5Slas } from "@/lib/admin/p5/evaluator";
import { resolveP5OperationalPolicy } from "@/lib/admin/p5/policy";
import { setRuntimeD1Bindings, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import type { M8TaskMessage } from "@/lib/cloudflare/async-pipeline/contracts";
import { evaluateWatchdog, recordWatchdogEventsToD1 } from "@/lib/ops/watchdog";

export interface M8NativeEnvironment {
  WORLDCONS_OPS: D1RuntimeDatabase;
  WORLDCONS_CORE: D1RuntimeDatabase;
  WORLDCONS_INGEST: D1RuntimeDatabase;
  WORLDCONS_APP_SERVICE: {
    runAdminJobDrain(input: { idempotencyKey: string; maxJobs?: number; leaseSeconds?: number }): Promise<{
      mode: "worker";
      workerId: string;
      processed: number;
      claimed: number;
      succeeded: number;
      failed: number;
      jobs: unknown[];
      error?: string;
    }>;
  };
}

export async function executeM8TaskNative(
  env: M8NativeEnvironment,
  message: M8TaskMessage,
  step?: { do<T>(name: string, options: unknown, callback: () => Promise<T>): Promise<T> },
) {
  setRuntimeD1Bindings({
    worldcons_ops: env.WORLDCONS_OPS,
    worldcons_core: env.WORLDCONS_CORE,
    worldcons_ingest: env.WORLDCONS_INGEST,
  });
  const execute = async () => {
    if (message.kind === "admin-job-drain") {
      const result = await env.WORLDCONS_APP_SERVICE.runAdminJobDrain({
        idempotencyKey: message.idempotencyKey,
        maxJobs: 2,
        leaseSeconds: 1200,
      });
      return { kind: message.kind, ...result };
    }
    if (message.kind === "watchdog") {
      const evaluation = await evaluateWatchdog(new Date(message.scheduledFor), true);
      await recordWatchdogEventsToD1(evaluation, new Date(message.scheduledFor));
      return { kind: message.kind, evaluation, issueAction: null, compensation: null };
    }
    if (message.kind === "admin-health") {
      const policy = resolveP5OperationalPolicy();
      const end = new Date(message.scheduledFor);
      const start = new Date(end.getTime() - policy.minimumObservationHours * 3_600_000);
      const evidence = await getP5HealthEvidenceFromD1({
        observationStart: start.toISOString(),
        observationEnd: end.toISOString(),
        now: end,
      });
      if (!evidence.available) throw new Error("m8.admin_health_d1_evidence_unavailable");
      const slas = evaluateP5Slas(evidence, policy);
      const hardViolations = slas.filter((item) => item.status === "critical" || item.status === "unknown");
      return {
        schemaVersion: 1,
        generatedAt: end.toISOString(),
        available: evidence.available,
        status: evidence.available && hardViolations.length === 0 ? "passing" : "failing",
        hardViolationKeys: hardViolations.map((item) => item.key),
        slas,
        evidence,
      };
    }
    throw new Error(`m8.native_kind_unsupported:${message.kind}`);
  };
  return step
    ? step.do(`native-${message.kind}`, { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" }, timeout: "2 minutes" }, execute)
    : execute();
}
