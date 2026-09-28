import vinextHandler from "vinext/server/fetch-handler";
import type { ArtifactBlobR2Bucket } from "@/lib/storage/blob";
import { setRuntimeArtifactBlobR2Binding } from "@/lib/storage/runtime-binding";
import { createMemoryRuntimeJsonStateStore, setRuntimeJsonStateStore } from "@/lib/runtime/persistent-state";
import { setRuntimePlatform } from "@/lib/runtime/platform";
import { createWaitUntilBackgroundScheduler, setRuntimeBackgroundScheduler } from "@/lib/runtime/background";
import { setRuntimeD1Bindings, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
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
  setRuntimeSearchServiceBinding,
  type WorldconsSearchServiceFetcher,
} from "@/lib/cloudflare/services/search-service-binding";
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

interface WorldconsWorkerEnv {
  WORLDCONS_RAW: ArtifactBlobR2Bucket;
  WORLDCONS_CORE?: D1RuntimeDatabase;
  WORLDCONS_INGEST?: D1RuntimeDatabase;
  WORLDCONS_OPS?: D1RuntimeDatabase;
  WORLDCONS_SEARCH?: D1RuntimeDatabase;
  WORLDCONS_SEARCH_SERVICE?: WorldconsSearchServiceFetcher;
  WORLDCONS_SEARCH_SERVICE_ENABLED?: string;
  WORLDCONS_CCLMETASEARCH_SERVICE_ENABLED?: string;
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
    setRuntimePlatform("cloudflare-worker");
    setRuntimeJsonStateStore(createMemoryRuntimeJsonStateStore());
    setRuntimeArtifactBlobR2Binding(env.WORLDCONS_RAW);
    setRuntimeD1Bindings({
      worldcons_core: env.WORLDCONS_CORE,
      worldcons_ingest: env.WORLDCONS_INGEST,
      worldcons_ops: env.WORLDCONS_OPS,
      worldcons_search: env.WORLDCONS_SEARCH,
    });
    setRuntimeBackgroundScheduler(createWaitUntilBackgroundScheduler(ctx));
    setRuntimeD1ShadowConfig(resolveD1ShadowConfig(env as Record<string, string | undefined>));
    setRuntimeSiteEventsWriteAuthorityConfig(
      resolveSiteEventsWriteAuthorityConfig(env as Record<string, string | undefined>),
    );
    setRuntimeAdminAuditWriteAuthorityConfig(
      resolveAdminAuditWriteAuthorityConfig(env as Record<string, string | undefined>),
    );
    setRuntimeAdminArticleEditWriteAuthorityConfig(
      resolveAdminArticleEditWriteAuthorityConfig(env as Record<string, string | undefined>),
    );
    setRuntimeOpsHeartbeatReadAuthorityConfig(
      resolveOpsHeartbeatReadAuthorityConfig(env as Record<string, string | undefined>),
    );
    setRuntimeAdminOpsEventsWriteAuthorityConfig(
      resolveAdminOpsEventsWriteAuthorityConfig(env as Record<string, string | undefined>),
    );
    setRuntimeAdminOpsEventsReadAuthorityConfig(
      resolveAdminOpsEventsReadAuthorityConfig(env as Record<string, string | undefined>),
    );
    setRuntimeCoreWriteAuthorityConfig(
      resolveCoreWriteAuthorityConfig(env as Record<string, string | undefined>),
    );
    setRuntimeSearchServiceBinding(
      env.WORLDCONS_SEARCH_SERVICE,
      env.WORLDCONS_SEARCH_SERVICE_ENABLED?.trim().toLowerCase() === "true",
      env.WORLDCONS_CCLMETASEARCH_SERVICE_ENABLED?.trim().toLowerCase() === "true",
    );
    return handler.fetch(request, env, ctx);
  },
};
