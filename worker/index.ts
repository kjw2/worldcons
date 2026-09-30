import { WorkerEntrypoint } from "cloudflare:workers";
import vinextHandler from "vinext/server/fetch-handler";
import type { ArtifactBlobR2Bucket } from "@/lib/storage/blob";
import { setRuntimeArtifactBlobR2Binding } from "@/lib/storage/runtime-binding";
import { createMemoryRuntimeJsonStateStore, setRuntimeJsonStateStore } from "@/lib/runtime/persistent-state";
import { setRuntimePlatform } from "@/lib/runtime/platform";
import { createWaitUntilBackgroundScheduler, setRuntimeBackgroundScheduler } from "@/lib/runtime/background";
import {
  setRuntimeD1Bindings,
  setRuntimeSearchVectorBinding,
  type D1RuntimeDatabase,
} from "@/lib/cloudflare/d1/runtime-binding";
import { resolveD1ShadowConfig, setRuntimeD1ShadowConfig } from "@/lib/cloudflare/d1/shadow/config";
import {
  resolveSiteEventsWriteAuthorityConfig,
  setRuntimeSiteEventsWriteAuthorityConfig,
} from "@/lib/cloudflare/d1/write-authority/site-events";
import {
  resolveAdminAuditWriteAuthorityConfig,
  setRuntimeAdminAuditWriteAuthorityConfig,
} from "@/lib/cloudflare/d1/write-authority/admin-audit";
import {
  resolveAdminArticleEditWriteAuthorityConfig,
  setRuntimeAdminArticleEditWriteAuthorityConfig,
} from "@/lib/cloudflare/d1/write-authority/admin-article-edit";
import {
  createWorldconsSearchServiceApp,
  setRuntimeWorldconsSearchServiceEnv,
  type WorldconsSearchServiceEnv,
} from "@/lib/cloudflare/services/worldcons-search-service";
import {
  parseCclMetasearchSearchParams,
  type CclMetasearchSearchInput,
  type CclMetasearchSearchPage,
} from "@/lib/cclmetasearch/contract";
import { searchCclMetasearchWithEnv } from "@/lib/cclmetasearch/search";
import type { VectorizeIndexBinding } from "@/lib/cloudflare/search-vector/types";
import {
  OPS_HEARTBEAT_BOUNDARY_PATH,
  OPS_HEARTBEAT_BOUNDARY_READ_PATH,
  resolveOpsHeartbeatReadAuthorityConfig,
  setRuntimeOpsHeartbeatReadAuthorityConfig,
} from "@/lib/cloudflare/ops-write/heartbeat";
import {
  ADMIN_OPS_EVENTS_BOUNDARY_LATEST_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_LIST_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_PRUNE_PATH,
  resolveAdminOpsEventsReadAuthorityConfig,
  resolveAdminOpsEventsWriteAuthorityConfig,
  setRuntimeAdminOpsEventsReadAuthorityConfig,
  setRuntimeAdminOpsEventsWriteAuthorityConfig,
} from "@/lib/cloudflare/ops-write/admin-ops-events";
import {
  CORE_LIFECYCLE_BOUNDARY_PATH,
  CORE_PUBLICATION_BOUNDARY_PATH,
  resolveCoreWriteAuthorityConfig,
  setRuntimeCoreWriteAuthorityConfig,
} from "@/lib/cloudflare/core-write/authority";
import { INGEST_RUN_BOUNDARY_PATH } from "@/lib/cloudflare/ingest-write/ingestion-runs";
import { applyM13AuthorityProfileToEnvironment } from "@/lib/cloudflare/m13/authority-profile";
import {
  resolveRateLimitAuthorityConfig,
  setRuntimeRateLimitAuthorityConfig,
} from "@/lib/cloudflare/rate-limit/authority";
import {
  setRuntimeRateLimitDurableObjectBinding,
  type DurableObjectNamespaceLike,
} from "@/lib/cloudflare/rate-limit/runtime-binding";
import {
  handleOpsHeartbeatBoundary,
  type WorldconsOpsWriteWorkerEnv,
} from "../workers/ops-write/src/index";
import { countMissingEmbeddings, getEmbeddingReadiness, runEmbeddingBacklog } from "@/lib/ingest/embedding-backlog";
import { runD1RefreshTagCounts, runD1SummarizeArticle, runD1SummaryDrain } from "@/lib/cloudflare/summary/d1-summary-drain";

export { RateLimitBucketDurableObject } from "@/lib/cloudflare/rate-limit/durable-object";

interface WorldconsWorkerEnv {
  WORLDCONS_RAW: ArtifactBlobR2Bucket;
  WORLDCONS_CORE?: D1RuntimeDatabase;
  WORLDCONS_INGEST?: D1RuntimeDatabase;
  WORLDCONS_OPS?: D1RuntimeDatabase;
  WORLDCONS_SEARCH?: D1RuntimeDatabase;
  WORLDCONS_SEARCH_VECTOR?: VectorizeIndexBinding;
  WORLDCONS_RATE_LIMIT?: DurableObjectNamespaceLike;
  ENVIRONMENT?: string;
  PUBLIC_BASE_URL?: string;
  PUBLIC_SITE_BASE_URL?: string;
  EMBEDDING_PROVIDER?: string;
  SEMANTIC_SEARCH_ENABLED?: string;
  GEMINI_API_KEY?: string;
  GEMINI_API_KEYS?: string;
  GEMINI_EMBEDDING_MODEL?: string;
  GEMINI_SUMMARY_MODEL?: string;
  GEMINI_PINNED_MODEL?: string;
  CCL_METASEARCH_DB_TIMEOUT_MS?: string;
  WORLDCONS_M13_AUTHORITY_PROFILE?: string;
  WORLDCONS_RATE_LIMIT_AUTHORITY?: string;
  WORLDCONS_SITE_EVENTS_WRITE_AUTHORITY?: string;
  WORLDCONS_ADMIN_AUDIT_WRITE_AUTHORITY?: string;
  WORLDCONS_ADMIN_ARTICLE_EDIT_WRITE_AUTHORITY?: string;
  WORLDCONS_OPS_HEARTBEAT_READ_AUTHORITY?: string;
  WORLDCONS_ADMIN_OPS_EVENTS_WRITE_AUTHORITY?: string;
  WORLDCONS_ADMIN_OPS_EVENTS_READ_AUTHORITY?: string;
  WORLDCONS_CORE_WRITE_AUTHORITY?: string;
  [key: string]: unknown;
}

interface WorkerExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

interface VinextWorkerHandler {
  fetch(
    request: Request,
    env: WorldconsWorkerEnv,
    ctx: WorkerExecutionContextLike,
  ): Response | Promise<Response>;
}

const handler = vinextHandler as unknown as VinextWorkerHandler;

const OPS_WRITE_BOUNDARY_PATHS = new Set([
  OPS_HEARTBEAT_BOUNDARY_PATH,
  OPS_HEARTBEAT_BOUNDARY_READ_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_LATEST_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_LIST_PATH,
  ADMIN_OPS_EVENTS_BOUNDARY_PRUNE_PATH,
  INGEST_RUN_BOUNDARY_PATH,
  CORE_LIFECYCLE_BOUNDARY_PATH,
  CORE_PUBLICATION_BOUNDARY_PATH,
]);

export default {
  fetch(request: Request, env: WorldconsWorkerEnv, ctx: WorkerExecutionContextLike) {
    // M13 permanent D1 authority profile. This is the single bounded switch:
    // when `WORLDCONS_M13_AUTHORITY_PROFILE=d1` the authored per-domain
    // selectors are applied together when the permanent `d1` profile is set.
    // An unset profile keeps any explicit bounded canary selector intact, while
    // an invalid profile throws here (fail closed).
    const authorityEnv = applyM13AuthorityProfileToEnvironment(
      env as Record<string, string | undefined>,
    ) as WorldconsWorkerEnv;
    setRuntimePlatform("cloudflare-worker");
    setRuntimeJsonStateStore(createMemoryRuntimeJsonStateStore());
    setRuntimeArtifactBlobR2Binding(env.WORLDCONS_RAW);
    setRuntimeD1Bindings({
      worldcons_core: env.WORLDCONS_CORE,
      worldcons_ingest: env.WORLDCONS_INGEST,
      worldcons_ops: env.WORLDCONS_OPS,
      worldcons_search: env.WORLDCONS_SEARCH,
    });
    setRuntimeWorldconsSearchServiceEnv(env);
    setRuntimeSearchVectorBinding(env.WORLDCONS_SEARCH_VECTOR);
    setRuntimeRateLimitDurableObjectBinding(env.WORLDCONS_RATE_LIMIT);
    setRuntimeRateLimitAuthorityConfig(
      resolveRateLimitAuthorityConfig(authorityEnv as Record<string, string | undefined>),
    );
    setRuntimeBackgroundScheduler(createWaitUntilBackgroundScheduler(ctx));
    setRuntimeD1ShadowConfig(resolveD1ShadowConfig(authorityEnv as Record<string, string | undefined>));
    setRuntimeSiteEventsWriteAuthorityConfig(
      resolveSiteEventsWriteAuthorityConfig(authorityEnv as Record<string, string | undefined>),
    );
    setRuntimeAdminAuditWriteAuthorityConfig(
      resolveAdminAuditWriteAuthorityConfig(authorityEnv as Record<string, string | undefined>),
    );
    setRuntimeAdminArticleEditWriteAuthorityConfig(
      resolveAdminArticleEditWriteAuthorityConfig(authorityEnv as Record<string, string | undefined>),
    );
    setRuntimeOpsHeartbeatReadAuthorityConfig(
      resolveOpsHeartbeatReadAuthorityConfig(authorityEnv as Record<string, string | undefined>),
    );
    setRuntimeAdminOpsEventsWriteAuthorityConfig(
      resolveAdminOpsEventsWriteAuthorityConfig(authorityEnv as Record<string, string | undefined>),
    );
    setRuntimeAdminOpsEventsReadAuthorityConfig(
      resolveAdminOpsEventsReadAuthorityConfig(authorityEnv as Record<string, string | undefined>),
    );
    setRuntimeCoreWriteAuthorityConfig(
      resolveCoreWriteAuthorityConfig(authorityEnv as Record<string, string | undefined>),
    );
    if (OPS_WRITE_BOUNDARY_PATHS.has(new URL(request.url).pathname)) {
      return handleOpsHeartbeatBoundary(
        request,
        authorityEnv as unknown as WorldconsOpsWriteWorkerEnv,
      );
    }
    return handler.fetch(request, env, ctx);
  },
};

const searchServiceApp = createWorldconsSearchServiceApp();

export class WorldconsSearchService extends WorkerEntrypoint<WorldconsSearchServiceEnv> {
  fetch(request: Request): Response | Promise<Response> {
    const env = this.env;
    setRuntimeD1Bindings({
      worldcons_core: env.WORLDCONS_CORE,
      worldcons_search: env.WORLDCONS_SEARCH,
    });
    setRuntimeWorldconsSearchServiceEnv(env);
    return searchServiceApp.fetch(request, env);
  }

  async searchCclMetasearch(input: CclMetasearchSearchInput): Promise<CclMetasearchSearchPage> {
    const env = this.env;
    setRuntimeD1Bindings({
      worldcons_core: env.WORLDCONS_CORE,
      worldcons_search: env.WORLDCONS_SEARCH,
    });
    setRuntimeWorldconsSearchServiceEnv(env);

    const params = new URLSearchParams({
      q: input?.query ?? "",
      limit: String(input?.limit ?? ""),
      offset: String(input?.offset ?? ""),
      sort: input?.sort ?? "",
    });
    const validated = parseCclMetasearchSearchParams(params);
    return searchCclMetasearchWithEnv(validated, {
      PUBLIC_SITE_BASE_URL: env.PUBLIC_SITE_BASE_URL?.trim() || "https://worldcons.cclib.workers.dev",
      CORE_BINDING: env.WORLDCONS_CORE,
      SEARCH_BINDING: env.WORLDCONS_SEARCH,
      CCL_METASEARCH_DB_TIMEOUT_MS: env.CCL_METASEARCH_DB_TIMEOUT_MS,
    });
  }
}

export class WorldconsOpsService extends WorkerEntrypoint<WorldconsWorkerEnv> {
  async runSummaryDrain(input: { limit?: number; maxPasses?: number; sourceKey?: string; retryAttempts?: number; retryDelayMs?: number }) {
    const env = this.env;
    setRuntimePlatform("cloudflare-worker");
    setRuntimeJsonStateStore(createMemoryRuntimeJsonStateStore());
    setRuntimeD1Bindings({
      worldcons_core: env.WORLDCONS_CORE,
      worldcons_ingest: env.WORLDCONS_INGEST,
    });
    setRuntimeSearchVectorBinding(env.WORLDCONS_SEARCH_VECTOR);
    const apiKeys = [env.GEMINI_API_KEY, ...(env.GEMINI_API_KEYS ?? "").split(",")]
      .map((key) => key?.trim())
      .filter((key): key is string => Boolean(key));
    return runD1SummaryDrain({
      ...input,
      apiKeys,
      model: env.GEMINI_SUMMARY_MODEL?.trim() || env.GEMINI_PINNED_MODEL?.trim() || undefined,
    });
  }

  async runSummaryArticle(input: { articleId?: string; slug?: string; model?: string }) {
    const env = this.env;
    setRuntimePlatform("cloudflare-worker");
    setRuntimeJsonStateStore(createMemoryRuntimeJsonStateStore());
    setRuntimeD1Bindings({ worldcons_core: env.WORLDCONS_CORE, worldcons_ingest: env.WORLDCONS_INGEST });
    setRuntimeSearchVectorBinding(env.WORLDCONS_SEARCH_VECTOR);
    const apiKeys = [env.GEMINI_API_KEY, ...(env.GEMINI_API_KEYS ?? "").split(",")]
      .map((key) => key?.trim()).filter((key): key is string => Boolean(key));
    return runD1SummarizeArticle({
      ...input,
      apiKeys,
      model: input.model?.trim() || env.GEMINI_SUMMARY_MODEL?.trim() || env.GEMINI_PINNED_MODEL?.trim() || undefined,
    });
  }

  async runRefreshTagCounts() {
    const env = this.env;
    setRuntimePlatform("cloudflare-worker");
    setRuntimeD1Bindings({ worldcons_core: env.WORLDCONS_CORE });
    return runD1RefreshTagCounts();
  }

  async runEmbeddingBackfill(input: { limit?: number; maxPasses?: number; delayMs?: number }) {
    const env = this.env;
    setRuntimePlatform("cloudflare-worker");
    setRuntimeJsonStateStore(createMemoryRuntimeJsonStateStore());
    setRuntimeD1Bindings({ worldcons_core: env.WORLDCONS_CORE });
    setRuntimeSearchVectorBinding(env.WORLDCONS_SEARCH_VECTOR);
    const apiKeys = [env.GEMINI_API_KEY, ...(env.GEMINI_API_KEYS ?? "").split(",")]
      .map((key) => key?.trim())
      .filter((key): key is string => Boolean(key));
    if (apiKeys.length === 0) {
      return {
        status: "unavailable" as const,
        passes: 0,
        scanned: 0,
        embedded: 0,
        skipped: 0,
        failed: 0,
        missingBefore: await countMissingEmbeddings(),
        missingAfter: await countMissingEmbeddings(),
        readiness: await getEmbeddingReadiness(),
        stoppedReason: "Gemini API key is not configured.",
      };
    }
    const limit = Math.max(1, Math.min(input.limit ?? 8, 500));
    const maxPasses = Math.max(1, Math.min(input.maxPasses ?? 20, 100));
    const delayMs = Math.max(0, Math.min(input.delayMs ?? 0, 60_000));
    const missingBefore = await countMissingEmbeddings();
    const readinessBefore = await getEmbeddingReadiness();
    if (missingBefore === null || readinessBefore === null) {
      return {
        status: "unavailable" as const,
        passes: 0,
        scanned: 0,
        embedded: 0,
        skipped: 0,
        failed: 0,
        missingBefore,
        missingAfter: missingBefore,
        readiness: readinessBefore,
        stoppedReason: "D1 embedding readiness is unavailable.",
      };
    }
    if (readinessBefore.missingArticleCount === 0) {
      return {
        status: "completed" as const,
        passes: 0,
        scanned: 0,
        embedded: 0,
        skipped: 0,
        failed: 0,
        missingBefore,
        missingAfter: missingBefore,
        readiness: readinessBefore,
      };
    }
    let totalScanned = 0;
    let totalEmbedded = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let passes = 0;
    let status: "completed" | "deferred" | "unavailable" = "completed";
    let stoppedReason: string | undefined;
    let exhaustedPasses = true;

    for (let pass = 0; pass < maxPasses; pass += 1) {
      passes += 1;
      const result = await runEmbeddingBacklog({
        limit,
        delayMs,
        apiKeys: [env.GEMINI_API_KEY, ...(env.GEMINI_API_KEYS ?? "").split(",")]
          .map((key) => key?.trim())
          .filter((key): key is string => Boolean(key)),
        model: env.GEMINI_EMBEDDING_MODEL?.trim() || "gemini-embedding-001",
        provider: env.EMBEDDING_PROVIDER?.trim() || "gemini",
      });
      totalScanned += result.scanned;
      totalEmbedded += result.embedded;
      totalSkipped += result.skipped;
      totalFailed += result.failed;
      if (result.status !== "completed") {
        status = result.status;
        stoppedReason = result.stoppedReason;
        exhaustedPasses = false;
        break;
      }
      if (result.scanned === 0) {
        exhaustedPasses = false;
        break;
      }
      const readiness = await getEmbeddingReadiness();
      if (!readiness) {
        status = "unavailable";
        stoppedReason = "D1 embedding readiness is unavailable.";
        break;
      }
      if (readiness.missingArticleCount === 0) {
        exhaustedPasses = false;
        break;
      }
    }

    const missingAfter = await countMissingEmbeddings();
    const readiness = await getEmbeddingReadiness();
    if (status === "completed" && exhaustedPasses && readiness?.missingArticleCount) {
      status = "deferred";
      stoppedReason = "Embedding backfill reached its maximum pass count.";
    }
    return {
      status,
      passes,
      scanned: totalScanned,
      embedded: totalEmbedded,
      skipped: totalSkipped,
      failed: totalFailed,
      missingBefore,
      missingAfter,
      readiness,
      ...(stoppedReason ? { stoppedReason } : {}),
    };
  }
}
