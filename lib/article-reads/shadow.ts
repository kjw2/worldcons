import {
  D1_SHADOW_ARTICLE_READ_SURFACE,
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
import {
  createD1ArticleReadRepository,
  D1ArticleShadowSkipError,
} from "@/lib/article-reads/d1-repository";
import { D1ShadowTruncatedError } from "@/lib/reference-reads/d1-repository";
import type { ArticleListFilters } from "@/lib/db/types";
import type {
  ArticleReadOptions,
  ArticleReadRepository,
  ArticleReadSelect,
  RelatedArticleIdsOptions,
  TopViewedArticleFilters,
} from "@/lib/article-reads/types";

/**
 * M6.3 article-read shadow wrapper.
 *
 * The authoritative repository is selected exactly as before (Supabase when
 * configured). This wrapper NEVER replaces, modifies or blocks the authoritative
 * result: it awaits it, returns it immediately (same object identity), and —
 * only when every safety gate passes — schedules a background bounded D1 read
 * on the Worker's `ctx.waitUntil`.
 *
 * Gates (all required): the read flag is on, the `article_read` surface is
 * allowed, the authoritative call is a safe legacy/base-table shape (not a
 * publication projection or case-catalog V4 read, not a search/full-text M7
 * path, not an unsupported/ambiguous shape), the `worldcons_core` binding
 * exists, a background scheduler exists, the deterministic sample accepts, and
 * the per-isolate in-flight bound has room. If any gate fails the shadow is
 * SKIPPED and an event is emitted (or nothing when the read flag is off).
 */
export interface ArticleReadShadowOptions {
  /** Injected config; otherwise the runtime slot, then the environment, then off. */
  config?: D1ShadowConfig;
  environment?: Record<string, string | undefined>;
  /** Injected `worldcons_core` binding; otherwise resolved from the runtime slot. */
  binding?: D1RuntimeDatabase | null;
  /** Injected scheduler; otherwise resolved from the runtime slot. */
  scheduler?: RuntimeBackgroundScheduler | null;
  sink?: D1ShadowEventSink;
  /** Deterministic sampling source for tests. */
  random?: () => number;
  now?: () => number;
  /**
   * The authoritative adapter's public projection decision. When true the
   * authoritative call reads `public_article_projection_p3`, which is not
   * migrated to D1, so the affected article shadows skip. The selection point
   * injects the same decision the authoritative adapter makes; a direct
   * construction without it defaults to the conservative `true` (skip).
   */
  projection?: boolean;
  /**
   * The case-catalog public detail V4 decision (`public_article_detail_v4`).
   * Also not migrated to D1; defaults conservatively to `true` (skip).
   */
  caseCatalogPublic?: boolean;
}

const SHADOW_METHODS = [
  "listArticles",
  "listPublicSitemapArticles",
  "listTopViewedArticles",
  "listRelatedArticleIds",
  "getArticleBySelect",
  "getArticleSourceTextBySlug",
] as const;

export function articleReadShadowCoveredMethods(): readonly string[] {
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
  tables: string[];
  /** Method-level skip reason evaluated before the binding/scheduler gates. */
  skipReason?: string;
  runShadow: (binding: D1RuntimeDatabase) => Promise<unknown>;
}

export function withArticleReadShadow(
  authoritative: ArticleReadRepository,
  options: ArticleReadShadowOptions = {},
): ArticleReadRepository {
  const config =
    options.config ?? getRuntimeD1ShadowConfig() ?? resolveD1ShadowConfig(options.environment ?? {});
  const binding = options.binding !== undefined ? options.binding : getRuntimeD1Binding("worldcons_core");
  const scheduler = options.scheduler !== undefined ? options.scheduler : runtimeBackgroundScheduler();
  const sink = options.sink ?? defaultD1ShadowSink;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());
  const projection = options.projection ?? true;
  const caseCatalogPublic = options.caseCatalogPublic ?? true;

  const shadowRepository = createD1ArticleReadRepository({ binding, maxRows: config.maxRows });

  function baseEvent(method: string, tables: string[]): D1ShadowEvent {
    return {
      event: D1_SHADOW_EVENT_NAME,
      surface: D1_SHADOW_ARTICLE_READ_SURFACE,
      method,
      outcome: "skipped",
      reason: null,
      errorCode: null,
      db: "worldcons_core",
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

  function skipped(method: string, tables: string[], reason: string): void {
    emitD1ShadowEvent(sink, { ...baseEvent(method, tables), outcome: "skipped", reason });
  }

  function schedule(input: ScheduleInput): void {
    if (!config.readEnabled) return;
    if (!config.surfaces.has(D1_SHADOW_ARTICLE_READ_SURFACE)) {
      skipped(input.method, input.tables, "surface_not_allowed");
      return;
    }
    if (input.skipReason) {
      skipped(input.method, input.tables, input.skipReason);
      return;
    }
    if (!binding) {
      skipped(input.method, input.tables, "no_binding");
      return;
    }
    if (!scheduler) {
      skipped(input.method, input.tables, "no_scheduler");
      return;
    }
    if (random() >= config.sampleRate) {
      skipped(input.method, input.tables, "sampled_out");
      return;
    }
    if (!acquireShadowSlot(D1_SHADOW_ARTICLE_READ_SURFACE, config.maxInFlight)) {
      skipped(input.method, input.tables, "backpressure");
      return;
    }

    const startedAt = now();
    const bindingForTask = binding;

    const runTask = async (): Promise<void> => {
      const finish = (outcome: D1ShadowOutcome, reason: string | null, patch: Partial<D1ShadowEvent>): void => {
        emitD1ShadowEvent(sink, {
          ...baseEvent(input.method, input.tables),
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
        if (error instanceof D1ArticleShadowSkipError) {
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
          releaseShadowSlot(D1_SHADOW_ARTICLE_READ_SURFACE);
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
      releaseShadowSlot(D1_SHADOW_ARTICLE_READ_SURFACE);
      skipped(input.method, input.tables, "scheduler_rejected");
      return;
    }
    startTask();
  }

  /** The publication projection / V4 relations are not migrated to D1. */
  function projectionSkipReason(includeUnpublished: boolean, usesDetailRelation: boolean): string | undefined {
    if (includeUnpublished) return undefined;
    if (usesDetailRelation) return projection || caseCatalogPublic ? "projection_mode" : undefined;
    return projection ? "projection_mode" : undefined;
  }

  async function listArticles(filters: ArticleListFilters = {}) {
    const primary = await authoritative.listArticles(filters);
    let skipReason: string | undefined;
    if (filters.q) skipReason = "search_deferred_m7";
    else skipReason = projectionSkipReason(Boolean(filters.includeUnpublished), true);
    schedule({
      method: "listArticles",
      contract: { method: "listArticles", kind: "object", stableKey: null },
      primary,
      tables: ["articles", "article_tags", "tags", "article_view_counts"],
      skipReason,
      runShadow: () => shadowRepository.listArticles(filters),
    });
    return primary;
  }

  async function listPublicSitemapArticles() {
    const primary = await authoritative.listPublicSitemapArticles();
    schedule({
      method: "listPublicSitemapArticles",
      contract: { method: "listPublicSitemapArticles", kind: "array", stableKey: "slug" },
      primary,
      tables: ["articles"],
      skipReason: projectionSkipReason(false, false),
      runShadow: () => shadowRepository.listPublicSitemapArticles(),
    });
    return primary;
  }

  async function listTopViewedArticles(limit = 5, filters: TopViewedArticleFilters = {}) {
    const primary = await authoritative.listTopViewedArticles(limit, filters);
    schedule({
      method: "listTopViewedArticles",
      contract: { method: "listTopViewedArticles", kind: "array", stableKey: "slug" },
      primary,
      tables: ["article_view_counts", "articles", "article_tags", "tags"],
      skipReason: projectionSkipReason(false, true),
      runShadow: () => shadowRepository.listTopViewedArticles(limit, filters),
    });
    return primary;
  }

  async function listRelatedArticleIds(tagId: string, options: RelatedArticleIdsOptions) {
    const primary = await authoritative.listRelatedArticleIds(tagId, options);
    let skipReason: string | undefined;
    if (typeof tagId !== "string" || tagId.trim().length === 0) skipReason = "invalid_tag";
    else if (!Number.isInteger(options?.limit) || (options?.limit ?? 0) <= 0) skipReason = "unbounded";
    else if ((options?.limit ?? 0) > config.maxRows) skipReason = "limit_exceeds_max_rows";
    schedule({
      method: "listRelatedArticleIds",
      contract: { method: "listRelatedArticleIds", kind: "array", stableKey: null, unordered: true },
      primary,
      tables: ["article_tags"],
      skipReason,
      runShadow: () => shadowRepository.listRelatedArticleIds(tagId, options),
    });
    return primary;
  }

  async function getArticleBySelect(slug: string, select: ArticleReadSelect, readOptions: ArticleReadOptions = {}) {
    const primary = await authoritative.getArticleBySelect(slug, select, readOptions);
    schedule({
      method: "getArticleBySelect",
      contract: { method: "getArticleBySelect", kind: "object", stableKey: null },
      primary,
      tables: ["articles", "article_tags", "tags"],
      skipReason: projectionSkipReason(Boolean(readOptions.includeUnpublished), true),
      runShadow: () => shadowRepository.getArticleBySelect(slug, select, readOptions),
    });
    return primary;
  }

  async function getArticleSourceTextBySlug(slug: string, readOptions: ArticleReadOptions = {}) {
    const primary = await authoritative.getArticleSourceTextBySlug(slug, readOptions);
    schedule({
      method: "getArticleSourceTextBySlug",
      contract: { method: "getArticleSourceTextBySlug", kind: "object", stableKey: null },
      primary,
      tables: ["articles"],
      skipReason: projectionSkipReason(Boolean(readOptions.includeUnpublished), true),
      runShadow: () => shadowRepository.getArticleSourceTextBySlug(slug, readOptions),
    });
    return primary;
  }

  return {
    listArticles,
    listPublicSitemapArticles,
    listTopViewedArticles,
    listRelatedArticleIds,
    getArticleBySelect,
    getArticleSourceTextBySlug,
  };
}
