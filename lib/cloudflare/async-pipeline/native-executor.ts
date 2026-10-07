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
  TRANSLATION_DRAIN_LIMIT?: string;
  TRANSLATION_DRAIN_MAX_PASSES?: string;
  PUBLICATION_DRAIN_LIMIT?: string;
  WORLDCONS_APP_SERVICE: {
    runEmbeddingBackfill(input: { limit?: number; maxPasses?: number; delayMs?: number }): Promise<{
      status: "completed" | "deferred" | "unavailable";
      passes: number;
      scanned: number;
      embedded: number;
      skipped: number;
      failed: number;
      missingBefore: number | null;
      missingAfter: number | null;
      readiness: unknown;
      stoppedReason?: string;
    }>;
    runSummaryDrain(input: { limit?: number; maxPasses?: number; sourceKey?: string; retryAttempts?: number; retryDelayMs?: number }): Promise<{
      mode: "database";
      status: "completed" | "deferred" | "failed" | "unavailable";
      summarizedCount: number;
      failedCount: number;
      skippedCount: number;
      deferredCount: number;
      candidateCount: number;
      attemptedCount: number;
      retryCount: number;
      passes: number;
      limitReached: boolean;
      stoppedReason?: string;
    }>;
    runPublicationDrain(input: { limit?: number }): Promise<{
      mode: "database";
      status: "completed" | "degraded";
      selectedCount: number;
      publishedCount: number;
      failedCount: number;
      remainingCount: number;
      failures: Array<{ articleId: string; error: string }>;
    }>;
    runSummaryArticle(input: { articleId?: string; slug?: string; model?: string }): Promise<unknown>;
    runRefreshTagCounts(): Promise<unknown>;
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
    if (message.kind === "embedding-backfill") {
      const result = await env.WORLDCONS_APP_SERVICE.runEmbeddingBackfill({
        limit: 8,
        maxPasses: 20,
        delayMs: 0,
      });
      return { kind: message.kind, ...result };
    }
    if (message.kind === "translation-drain") {
      const limit = Math.max(1, Math.min(Number(env.TRANSLATION_DRAIN_LIMIT ?? 5) || 5, 50));
      const maxPasses = Math.max(1, Math.min(Number(env.TRANSLATION_DRAIN_MAX_PASSES ?? 1) || 1, 10));
      const result = await env.WORLDCONS_APP_SERVICE.runSummaryDrain({
        limit,
        maxPasses,
        retryAttempts: 1,
        retryDelayMs: 65_000,
      });
      return { kind: message.kind, ...result };
    }
    if (message.kind === "publication-drain") {
      const limit = Math.max(1, Math.min(Number(env.PUBLICATION_DRAIN_LIMIT ?? 100) || 100, 500));
      const result = await env.WORLDCONS_APP_SERVICE.runPublicationDrain({ limit });
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
    ? step.do(`native-${message.kind}`, {
      retries: { limit: 5, delay: "30 seconds", backoff: "exponential" },
      timeout: message.kind === "embedding-backfill" || message.kind === "translation-drain" ? "50 minutes" : "2 minutes",
    }, execute)
    : execute();
}
