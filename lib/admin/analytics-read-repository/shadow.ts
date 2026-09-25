import {
  D1_SHADOW_ADMIN_ANALYTICS_READ_SURFACE,
  getRuntimeD1ShadowConfig,
  resolveD1ShadowConfig,
  type D1ShadowConfig,
} from "@/lib/cloudflare/d1/shadow/config";
import { compareD1Shadow, type D1ShadowContract } from "@/lib/cloudflare/d1/shadow/compare";
import {
  D1_SHADOW_EVENT_NAME,
  defaultD1ShadowSink,
  emitD1ShadowEvent,
  type D1ShadowEvent,
  type D1ShadowEventSink,
  type D1ShadowOutcome,
} from "@/lib/cloudflare/d1/shadow/events";
import { acquireShadowSlot, releaseShadowSlot } from "@/lib/cloudflare/d1/shadow/inflight";
import { getRuntimeD1Binding, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import { runtimeBackgroundScheduler, type RuntimeBackgroundScheduler } from "@/lib/runtime/background";
import { D1ShadowTruncatedError } from "@/lib/reference-reads/d1-repository";
import {
  createD1AdminAnalyticsReadRepository,
  D1AdminAnalyticsShadowSkipError,
} from "@/lib/admin/analytics-read-repository/d1-read-repository";
import type {
  AdminAnalyticsReadRepository,
  AdminAuditEntryRowsRequest,
  AdminAuditEntryRowsResult,
} from "@/lib/admin/analytics-read-repository/types";

/**
 * M6.4 privileged admin analytics/audit read shadow wrapper.
 *
 * The authoritative repository is selected exactly as before (Supabase when
 * configured). This wrapper NEVER replaces, modifies or blocks the authoritative
 * result: it awaits it, returns it immediately (same object identity), and — only
 * when every safety gate passes — schedules a background bounded D1 read on the
 * Worker's `ctx.waitUntil`.
 *
 * Gates (all required): the read flag is on, the `admin_analytics_read` surface
 * is allowed, the method is not skipped (RPC / ambiguous shape), the exact
 * per-method database binding exists (`worldcons_ops` for `site_events`,
 * `worldcons_ingest` for `ingestion_runs`, `worldcons_core` for `articles`), a
 * background scheduler exists, the deterministic sample accepts, and the
 * per-isolate in-flight bound has room. D1 errors never alter the authoritative
 * result.
 *
 * `loadAnalyticsHealthSnapshot` and `isConfigured` stay direct authoritative
 * behavior: neither schedules D1 work. The snapshot RPC has no migrated D1
 * equivalent, so it emits an explicit `rpc_deferred` skip and makes ZERO D1
 * calls.
 */
export interface AdminAnalyticsReadShadowOptions {
  /** Injected config; otherwise the runtime slot, then the environment, then off. */
  config?: D1ShadowConfig;
  environment?: Record<string, string | undefined>;
  /** Injected `worldcons_core` binding; otherwise resolved from the runtime slot. */
  binding?: D1RuntimeDatabase | null;
  /** Injected `worldcons_ingest` binding; otherwise resolved from the runtime slot. */
  ingestBinding?: D1RuntimeDatabase | null;
  /** Injected `worldcons_ops` binding; otherwise resolved from the runtime slot. */
  opsBinding?: D1RuntimeDatabase | null;
  /** Injected scheduler; otherwise resolved from the runtime slot. */
  scheduler?: RuntimeBackgroundScheduler | null;
  sink?: D1ShadowEventSink;
  /** Deterministic sampling source for tests. */
  random?: () => number;
  now?: () => number;
}

const SHADOW_METHODS = [
  "loadAdminAuditActionOptionRows",
  "loadAdminAuditEntryRows",
  "loadSiteEvents",
  "loadIngestionRunRows",
  "loadArticleSummaryRows",
  "loadAnalyticsHealthSnapshot",
] as const;

export function adminAnalyticsReadShadowCoveredMethods(): readonly string[] {
  return SHADOW_METHODS;
}

class ShadowTimeoutError extends Error {
  constructor() {
    super("d1 shadow timed out");
    this.name = "D1ShadowTimeoutError";
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  if (error instanceof Error && error.name) return error.name;
  return "unknown_error";
}

function withShadowTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ShadowTimeoutError()), timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface ScheduleInput {
  method: string;
  contract: D1ShadowContract;
  primary: unknown;
  db: string;
  tables: string[];
  /** The exact D1 binding this method reads. */
  binding: D1RuntimeDatabase | null;
  /** Method-level skip reason evaluated before the binding/scheduler gates. */
  skipReason?: string;
  runShadow: (binding: D1RuntimeDatabase) => Promise<unknown>;
}

export function withAdminAnalyticsReadShadow(
  authoritative: AdminAnalyticsReadRepository,
  options: AdminAnalyticsReadShadowOptions = {},
): AdminAnalyticsReadRepository {
  const config =
    options.config ?? getRuntimeD1ShadowConfig() ?? resolveD1ShadowConfig(options.environment ?? {});
  const coreBinding = options.binding !== undefined ? options.binding : getRuntimeD1Binding("worldcons_core");
  const ingestBinding =
    options.ingestBinding !== undefined ? options.ingestBinding : getRuntimeD1Binding("worldcons_ingest");
  const opsBinding = options.opsBinding !== undefined ? options.opsBinding : getRuntimeD1Binding("worldcons_ops");
  const scheduler = options.scheduler !== undefined ? options.scheduler : runtimeBackgroundScheduler();
  const sink = options.sink ?? defaultD1ShadowSink;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());

  const shadowRepository = createD1AdminAnalyticsReadRepository({
    binding: coreBinding,
    ingestBinding,
    opsBinding,
    maxRows: config.maxRows,
  });

  function baseEvent(method: string, db: string, tables: string[]): D1ShadowEvent {
    return {
      event: D1_SHADOW_EVENT_NAME,
      surface: D1_SHADOW_ADMIN_ANALYTICS_READ_SURFACE,
      method,
      outcome: "skipped",
      reason: null,
      errorCode: null,
      db,
      tables,
      primaryCount: null,
      shadowCount: null,
      primaryHash: null,
      shadowHash: null,
      diffPath: null,
      orderMatches: null,
      compared: false,
      readOutcome: null,
      latencyMs: null,
    };
  }

  function skipped(method: string, db: string, tables: string[], reason: string): void {
    emitD1ShadowEvent(sink, { ...baseEvent(method, db, tables), outcome: "skipped", reason });
  }

  function schedule(input: ScheduleInput): void {
    if (!config.readEnabled) return;
    if (!config.surfaces.has(D1_SHADOW_ADMIN_ANALYTICS_READ_SURFACE)) {
      skipped(input.method, input.db, input.tables, "surface_not_allowed");
      return;
    }
    if (input.skipReason) {
      skipped(input.method, input.db, input.tables, input.skipReason);
      return;
    }
    if (!input.binding) {
      skipped(input.method, input.db, input.tables, "no_binding");
      return;
    }
    if (!scheduler) {
      skipped(input.method, input.db, input.tables, "no_scheduler");
      return;
    }
    if (random() >= config.sampleRate) {
      skipped(input.method, input.db, input.tables, "sampled_out");
      return;
    }
    if (!acquireShadowSlot(D1_SHADOW_ADMIN_ANALYTICS_READ_SURFACE, config.maxInFlight)) {
      skipped(input.method, input.db, input.tables, "backpressure");
      return;
    }

    const startedAt = now();
    const bindingForTask = input.binding;

    const runTask = async (): Promise<void> => {
      const finish = (outcome: D1ShadowOutcome, reason: string | null, patch: Partial<D1ShadowEvent>): void => {
        emitD1ShadowEvent(sink, {
          ...baseEvent(input.method, input.db, input.tables),
          outcome,
          reason,
          latencyMs: Math.max(0, now() - startedAt),
          ...patch,
        });
      };
      try {
        const shadow = await withShadowTimeout(input.runShadow(bindingForTask), config.timeoutMs);
        if (!config.compareEnabled) {
          finish("disabled", "compare_disabled", { compared: false, readOutcome: "success" });
          return;
        }
        const comparison = compareD1Shadow(input.contract, input.primary, shadow);
        finish(comparison.matched ? "matched" : "mismatched", comparison.matched ? null : "result_mismatch", {
          compared: true,
          readOutcome: "success",
          primaryCount: comparison.primaryCount,
          shadowCount: comparison.shadowCount,
          primaryHash: comparison.primaryHash,
          shadowHash: comparison.shadowHash,
          diffPath: comparison.diffPath,
          orderMatches: comparison.orderMatches,
        });
      } catch (error) {
        if (error instanceof D1ShadowTruncatedError) {
          finish("skipped", "shadow_truncated", { compared: false, readOutcome: "success" });
          return;
        }
        if (error instanceof D1AdminAnalyticsShadowSkipError) {
          finish("skipped", error.reason, { compared: false, readOutcome: "success" });
          return;
        }
        const timeout = error instanceof ShadowTimeoutError;
        finish(timeout ? "timeout" : "error", timeout ? "timeout" : "shadow_read_failed", {
          compared: false,
          readOutcome: timeout ? "timeout" : "error",
          errorCode: errorCode(error),
        });
      }
    };

    let startTask: () => void = () => {};
    const scheduled = new Promise<void>((resolve) => {
      startTask = () => {
        void runTask().finally(() => {
          releaseShadowSlot(D1_SHADOW_ADMIN_ANALYTICS_READ_SURFACE);
          resolve();
        });
      };
    });

    let accepted = false;
    try {
      accepted = scheduler.schedule(scheduled);
    } catch {
      accepted = false;
    }
    if (!accepted) {
      releaseShadowSlot(D1_SHADOW_ADMIN_ANALYTICS_READ_SURFACE);
      skipped(input.method, input.db, input.tables, "scheduler_rejected");
      return;
    }
    startTask();
  }

  function isConfigured() {
    return authoritative.isConfigured();
  }

  async function loadAdminAuditActionOptionRows(eventTypes: string[]) {
    const primary = await authoritative.loadAdminAuditActionOptionRows(eventTypes);
    schedule({
      method: "loadAdminAuditActionOptionRows",
      contract: { method: "loadAdminAuditActionOptionRows", kind: "array", stableKey: "id" },
      primary,
      db: "worldcons_ops",
      tables: ["site_events"],
      binding: opsBinding,
      runShadow: () => shadowRepository.loadAdminAuditActionOptionRows(eventTypes),
    });
    return primary;
  }

  async function loadAdminAuditEntryRows(request: AdminAuditEntryRowsRequest): Promise<AdminAuditEntryRowsResult> {
    const primary = await authoritative.loadAdminAuditEntryRows(request);
    schedule({
      method: "loadAdminAuditEntryRows",
      contract: { method: "loadAdminAuditEntryRows", kind: "object", stableKey: null },
      primary,
      db: "worldcons_ops",
      tables: ["site_events"],
      binding: opsBinding,
      runShadow: () => shadowRepository.loadAdminAuditEntryRows(request),
    });
    return primary;
  }

  async function loadSiteEvents(since: string) {
    const primary = await authoritative.loadSiteEvents(since);
    schedule({
      method: "loadSiteEvents",
      contract: { method: "loadSiteEvents", kind: "object", stableKey: null },
      primary,
      db: "worldcons_ops",
      tables: ["site_events"],
      binding: opsBinding,
      runShadow: () => shadowRepository.loadSiteEvents(since),
    });
    return primary;
  }

  async function loadIngestionRunRows(since: string) {
    const primary = await authoritative.loadIngestionRunRows(since);
    schedule({
      method: "loadIngestionRunRows",
      contract: { method: "loadIngestionRunRows", kind: "array", stableKey: "source_key", unordered: true },
      primary,
      db: "worldcons_ingest",
      tables: ["ingestion_runs"],
      binding: ingestBinding,
      runShadow: () => shadowRepository.loadIngestionRunRows(since),
    });
    return primary;
  }

  async function loadArticleSummaryRows() {
    const primary = await authoritative.loadArticleSummaryRows();
    schedule({
      method: "loadArticleSummaryRows",
      contract: { method: "loadArticleSummaryRows", kind: "array", stableKey: null, unordered: true },
      primary,
      db: "worldcons_core",
      tables: ["articles"],
      binding: coreBinding,
      runShadow: () => shadowRepository.loadArticleSummaryRows(),
    });
    return primary;
  }

  async function loadAnalyticsHealthSnapshot(days: number): Promise<unknown | null> {
    const primary = await authoritative.loadAnalyticsHealthSnapshot(days);
    schedule({
      method: "loadAnalyticsHealthSnapshot",
      contract: { method: "loadAnalyticsHealthSnapshot", kind: "object", stableKey: null },
      primary,
      db: "worldcons_core",
      tables: [],
      binding: null,
      skipReason: "rpc_deferred",
      runShadow: async () => primary,
    });
    return primary;
  }

  return {
    isConfigured,
    loadAdminAuditActionOptionRows,
    loadAdminAuditEntryRows,
    loadSiteEvents,
    loadIngestionRunRows,
    loadArticleSummaryRows,
    loadAnalyticsHealthSnapshot,
  };
}
