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
  resolveOpsHeartbeatReadAuthorityConfig,
  setRuntimeOpsHeartbeatReadAuthorityConfig,
} from "@/lib/cloudflare/ops-write/heartbeat";
import {
  resolveAdminOpsEventsReadAuthorityConfig,
  resolveAdminOpsEventsWriteAuthorityConfig,
  setRuntimeAdminOpsEventsReadAuthorityConfig,
  setRuntimeAdminOpsEventsWriteAuthorityConfig,
} from "@/lib/cloudflare/ops-write/admin-ops-events";
import {
  resolveCoreWriteAuthorityConfig,
  setRuntimeCoreWriteAuthorityConfig,
} from "@/lib/cloudflare/core-write/authority";
import { applyM13AuthorityProfileToEnvironment } from "@/lib/cloudflare/m13/authority-profile";
import {
  resolveRateLimitAuthorityConfig,
  setRuntimeRateLimitAuthorityConfig,
} from "@/lib/cloudflare/rate-limit/authority";
import {
  setRuntimeRateLimitDurableObjectBinding,
  type DurableObjectNamespaceLike,
} from "@/lib/cloudflare/rate-limit/runtime-binding";

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
  GEMINI_EMBEDDING_MODEL?: string;
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

export default {
  fetch(request: Request, env: WorldconsWorkerEnv, ctx: WorkerExecutionContextLike) {
    // M13 permanent D1 authority profile. This is the single bounded switch:
    // when `WORLDCONS_M13_AUTHORITY_PROFILE=d1` the authored per-domain
    // selectors are applied together; the resting `supabase`/unset profile
    // leaves `env` untouched. An invalid profile throws here (fail closed)
    // rather than silently running under the resting default.
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
      PUBLIC_SITE_BASE_URL: env.PUBLIC_SITE_BASE_URL?.trim() || "https://worldcons.soltera.dev",
      CORE_BINDING: env.WORLDCONS_CORE,
      SEARCH_BINDING: env.WORLDCONS_SEARCH,
      CCL_METASEARCH_DB_TIMEOUT_MS: env.CCL_METASEARCH_DB_TIMEOUT_MS,
    });
  }
}
