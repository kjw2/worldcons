import {
  D1_SHADOW_REFERENCE_SURFACE,
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
import { createD1ReferenceReadRepository, D1ShadowTruncatedError } from "@/lib/reference-reads/d1-repository";
import { normalizeTagListOptions } from "@/lib/reference-reads/shared";
import type { JurisdictionCountOptions, ReferenceReadRepository, TagListOptions } from "@/lib/reference-reads/types";

/**
 * M6.1 + M6.2 reference-read shadow wrapper.
 *
 * The authoritative repository is selected exactly as before (Supabase when
 * configured). This wrapper NEVER replaces, modifies or blocks the
 * authoritative result: it awaits it, returns it immediately, and — only when
 * every safety gate passes — schedules a background D1 read on the Worker's
 * `ctx.waitUntil`.
 *
 * Gates (all required): the read flag is on, the `reference` surface is allowed,
 * the method is not skipped (projection mode / unbounded tags), the method's D1
 * binding exists (core or ingest), a background scheduler exists, the
 * deterministic sample accepts, and the per-isolate in-flight bound has room.
 * If any gate fails, the shadow is SKIPPED and an event is emitted (or nothing
 * when the read flag is off). No scheduler means skip, never a synchronous
 * await. Errors, timeouts, truncation and backpressure are swallowed into
 * events.
 */
export interface ReferenceReadShadowOptions {
  /** Injected config; otherwise the runtime slot, then the environment, then off. */
  config?: D1ShadowConfig;
  environment?: Record<string, string | undefined>;
  /** Injected `worldcons_core` binding; otherwise resolved from the runtime slot. */
  binding?: D1RuntimeDatabase | null;
  /** Injected `worldcons_ingest` binding; otherwise resolved from the runtime slot. */
  ingestBinding?: D1RuntimeDatabase | null;
  /** Injected scheduler; otherwise resolved from the runtime slot. */
  scheduler?: RuntimeBackgroundScheduler | null;
  sink?: D1ShadowEventSink;
  /** Deterministic sampling source for tests. */
  random?: () => number;
  now?: () => number;
  /**
   * The authoritative Supabase adapter's projection decision. When true the
   * tag table and `public_tag_projection_p3` agree, but that projection is not
   * migrated to D1, so tag and jurisdiction-count shadows skip. The selection
   * point injects the same decision the authoritative adapter makes; a direct
   * construction without it defaults to the conservative `true` (skip).
   */
  projection?: boolean;
}

const SHADOW_METHODS = [
  "listSources",
  "listGlossaryTerms",
  "getGlossaryTerm",
  "listTags",
  "getTagBySlug",
  "listIngestionRuns",
  "listJurisdictionArticleCounts",
] as const;

export function referenceReadShadowCoveredMethods(): readonly string[] {
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
  /** The D1 binding this method reads (core or ingest). */
  binding: D1RuntimeDatabase | null;
  /** Method-level skip reason evaluated before the binding/scheduler gates. */
  skipReason?: string;
  runShadow: (binding: D1RuntimeDatabase) => Promise<unknown>;
}

export function withReferenceReadShadow(
  authoritative: ReferenceReadRepository,
  options: ReferenceReadShadowOptions = {},
): ReferenceReadRepository {
  const config =
    options.config ?? getRuntimeD1ShadowConfig() ?? resolveD1ShadowConfig(options.environment ?? {});
  const coreBinding =
    options.binding !== undefined ? options.binding : getRuntimeD1Binding("worldcons_core");
  const ingestBinding =
    options.ingestBinding !== undefined ? options.ingestBinding : getRuntimeD1Binding("worldcons_ingest");
  const scheduler = options.scheduler !== undefined ? options.scheduler : runtimeBackgroundScheduler();
  const sink = options.sink ?? defaultD1ShadowSink;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());
  const projection = options.projection ?? true;

  const shadowRepository = createD1ReferenceReadRepository({
    binding: coreBinding,
    ingestBinding,
    maxRows: config.maxRows,
  });

  function baseEvent(method: string, db: string, tables: string[]): D1ShadowEvent {
    return {
      event: D1_SHADOW_EVENT_NAME,
      surface: D1_SHADOW_REFERENCE_SURFACE,
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
    if (!config.surfaces.has(D1_SHADOW_REFERENCE_SURFACE)) {
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
    if (!acquireShadowSlot(D1_SHADOW_REFERENCE_SURFACE, config.maxInFlight)) {
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
          releaseShadowSlot(D1_SHADOW_REFERENCE_SURFACE);
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
      releaseShadowSlot(D1_SHADOW_REFERENCE_SURFACE);
      skipped(input.method, input.db, input.tables, "scheduler_rejected");
      return;
    }
    startTask();
  }

  function tagSkipReason(options?: TagListOptions): string | undefined {
    if (projection) return "projection_mode";
    const normalized = normalizeTagListOptions(options);
    if (!normalized.limit) return "unbounded";
    if (normalized.limit > config.maxRows) return "limit_exceeds_max_rows";
    return undefined;
  }

  async function listSources() {
    const primary = await authoritative.listSources();
    schedule({
      method: "listSources",
      contract: { method: "listSources", kind: "array", stableKey: "sourceKey" },
      primary,
      db: "worldcons_core",
      tables: ["sources"],
      binding: coreBinding,
      runShadow: () => shadowRepository.listSources(),
    });
    return primary;
  }

  async function listGlossaryTerms() {
    const primary = await authoritative.listGlossaryTerms();
    schedule({
      method: "listGlossaryTerms",
      contract: { method: "listGlossaryTerms", kind: "array", stableKey: "slug" },
      primary,
      db: "worldcons_core",
      tables: ["glossary_terms"],
      binding: coreBinding,
      runShadow: () => shadowRepository.listGlossaryTerms(),
    });
    return primary;
  }

  async function getGlossaryTerm(slug: string) {
    const primary = await authoritative.getGlossaryTerm(slug);
    schedule({
      method: "getGlossaryTerm",
      contract: { method: "getGlossaryTerm", kind: "object", stableKey: null },
      primary,
      db: "worldcons_core",
      tables: ["glossary_terms"],
      binding: coreBinding,
      runShadow: () => shadowRepository.getGlossaryTerm(slug),
    });
    return primary;
  }

  async function listTags(options?: TagListOptions) {
    const primary = await authoritative.listTags(options);
    schedule({
      method: "listTags",
      contract: { method: "listTags", kind: "array", stableKey: "slug" },
      primary,
      db: "worldcons_core",
      tables: ["tags"],
      binding: coreBinding,
      skipReason: tagSkipReason(options),
      runShadow: () => shadowRepository.listTags(options),
    });
    return primary;
  }

  async function getTagBySlug(slug: string) {
    const primary = await authoritative.getTagBySlug(slug);
    schedule({
      method: "getTagBySlug",
      contract: { method: "getTagBySlug", kind: "object", stableKey: null },
      primary,
      db: "worldcons_core",
      tables: ["tags"],
      binding: coreBinding,
      skipReason: projection ? "projection_mode" : undefined,
      runShadow: () => shadowRepository.getTagBySlug(slug),
    });
    return primary;
  }

  async function listIngestionRuns(limit?: number) {
    const primary = await authoritative.listIngestionRuns(limit);
    schedule({
      method: "listIngestionRuns",
      contract: { method: "listIngestionRuns", kind: "array", stableKey: "id" },
      primary,
      db: "worldcons_ingest",
      tables: ["ingestion_runs"],
      binding: ingestBinding,
      runShadow: () => shadowRepository.listIngestionRuns(limit),
    });
    return primary;
  }

  async function listJurisdictionArticleCounts(
    jurisdictions?: string[],
    options?: JurisdictionCountOptions,
  ) {
    const primary = await authoritative.listJurisdictionArticleCounts(jurisdictions, options);
    schedule({
      method: "listJurisdictionArticleCounts",
      contract: { method: "listJurisdictionArticleCounts", kind: "object", stableKey: null },
      primary,
      db: "worldcons_core",
      tables: ["articles"],
      binding: coreBinding,
      skipReason: projection ? "projection_mode" : undefined,
      runShadow: () => shadowRepository.listJurisdictionArticleCounts(jurisdictions, options),
    });
    return primary;
  }

  return {
    listSources,
    listGlossaryTerms,
    getGlossaryTerm,
    listTags,
    getTagBySlug,
    listIngestionRuns,
    listJurisdictionArticleCounts,
  };
}
