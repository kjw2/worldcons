import { Hono, type Context } from "hono";
import {
  handleWorldconsSearchRequest,
  type Cclrag2ProviderEnv,
  type ProviderDependencies,
} from "@/lib/integrations/cclrag2/provider-handler";
import {
  parseCclMetasearchSearchParams,
  type CclMetasearchSearchInput,
  type CclMetasearchSearchPage,
} from "@/lib/cclmetasearch/contract";
import {
  searchCclMetasearchWithEnv,
  type CclMetasearchSearchDependencies,
} from "@/lib/cclmetasearch/search";
import type { D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import {
  SITE_EVENT_TYPE_VALUES,
} from "@/lib/cloudflare/d1/schema/worldcons-ops";
import {
  parseOpsHeartbeatWriteRow,
  type OpsHeartbeatWriteRow,
} from "@/lib/cloudflare/ops-write/heartbeat";
import {
  ADMIN_OPS_EVENTS_SEARCH_LATEST_PATH,
  ADMIN_OPS_EVENTS_SEARCH_PATH,
  ADMIN_OPS_EVENTS_SEARCH_PRUNE_PATH,
  parseAdminOpsEventRecord,
  parseAdminOpsEventWriteRow,
  type AdminOpsEventRecord,
  type AdminOpsEventWriteRow,
} from "@/lib/cloudflare/ops-write/admin-ops-events";
import type {
  BoundAdminArticleEditWriteRow,
  BoundAdminAuditWriteRow,
  BoundSiteEventWriteRow,
} from "@/lib/cloudflare/services/search-service-binding";

export interface WorldconsSearchWorkerEnv {
  ENVIRONMENT?: string;
  PUBLIC_BASE_URL?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  EMBEDDING_PROVIDER?: string;
  SEMANTIC_SEARCH_ENABLED?: string;
  GEMINI_API_KEY?: string;
  GEMINI_EMBEDDING_MODEL?: string;
  PUBLIC_SITE_BASE_URL?: string;
  CCL_METASEARCH_DB_TIMEOUT_MS?: string;
  WORLDCONS_CORE?: D1RuntimeDatabase;
  WORLDCONS_SEARCH?: D1RuntimeDatabase;
}

const DEFAULT_PUBLIC_BASE_URL = "https://worldcons.vercel.app/api/cclrag2";

export function providerEnvFromSearchWorkerBindings(
  env: WorldconsSearchWorkerEnv,
): Cclrag2ProviderEnv {
  return {
    ENVIRONMENT: env.ENVIRONMENT?.trim() || "production",
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL?.trim() || DEFAULT_PUBLIC_BASE_URL,
    SUPABASE_URL: env.SUPABASE_URL?.trim() || "",
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "",
    EMBEDDING_PROVIDER: env.EMBEDDING_PROVIDER,
    SEMANTIC_SEARCH_ENABLED: env.SEMANTIC_SEARCH_ENABLED,
    GEMINI_API_KEY: env.GEMINI_API_KEY,
    GEMINI_EMBEDDING_MODEL: env.GEMINI_EMBEDDING_MODEL,
  };
}

export interface WorldconsSearchServiceDependencies {
  provider?: ProviderDependencies;
  cclMetasearchSearch?: (
    input: CclMetasearchSearchInput,
    env: WorldconsSearchWorkerEnv,
  ) => Promise<CclMetasearchSearchPage>;
  cclMetasearchDependencies?: CclMetasearchSearchDependencies;
  siteEventWrite?: (
    row: BoundSiteEventWriteRow,
    env: WorldconsSearchWorkerEnv,
  ) => Promise<void>;
  adminAuditWrite?: (
    row: BoundAdminAuditWriteRow,
    env: WorldconsSearchWorkerEnv,
  ) => Promise<void>;
  adminArticleEditWrite?: (
    row: BoundAdminArticleEditWriteRow,
    env: WorldconsSearchWorkerEnv,
  ) => Promise<void>;
  opsHeartbeatWrite?: (
    row: OpsHeartbeatWriteRow,
    env: WorldconsSearchWorkerEnv,
  ) => Promise<void>;
  adminOpsEventWrite?: (
    row: AdminOpsEventWriteRow,
    env: WorldconsSearchWorkerEnv,
  ) => Promise<void>;
  adminOpsEventLatestRead?: (
    env: WorldconsSearchWorkerEnv,
  ) => Promise<AdminOpsEventRecord | null>;
  adminOpsEventPrune?: (
    cutoff: string,
    env: WorldconsSearchWorkerEnv,
  ) => Promise<void>;
}

export function createWorldconsSearchServiceApp(
  dependencies: WorldconsSearchServiceDependencies = {},
) {
  const app = new Hono<{ Bindings: WorldconsSearchWorkerEnv }>();

  app.get("/health", (c) => c.json({
    schemaVersion: 1,
    service: "worldcons-search",
    status: "ready",
    transport: "cloudflare-service-binding",
  }, 200, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }));

  const upstreamProbe = async (c: Context<{ Bindings: WorldconsSearchWorkerEnv }>) => {
    const supabaseUrl = c.env.SUPABASE_URL?.trim() || "";
    const serviceRoleKey = c.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
    const configured = {
      supabaseUrl: Boolean(supabaseUrl),
      serviceRoleKey: Boolean(serviceRoleKey),
      geminiApiKey: Boolean(c.env.GEMINI_API_KEY?.trim()),
    };

    let supabaseHost: string | null = null;
    try {
      supabaseHost = supabaseUrl ? new URL(supabaseUrl).host : null;
    } catch {
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        status: "unhealthy",
        configured,
        supabaseHost: null,
        rest: { ok: false, status: null, error: "invalid_supabase_url" },
        rpc: { ok: false, status: null, error: "invalid_supabase_url" },
      }, 503, { "Cache-Control": "no-store" });
    }

    if (!supabaseUrl || !serviceRoleKey) {
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        status: "unhealthy",
        configured,
        supabaseHost,
        rest: { ok: false, status: null, error: "not_configured" },
        rpc: { ok: false, status: null, error: "not_configured" },
      }, 503, { "Cache-Control": "no-store" });
    }

    const fetcher = dependencies.provider?.fetcher ?? fetch;
    const rest = await probeSupabase(fetcher, supabaseUrl, serviceRoleKey, "/rest/v1/", undefined, 3_000);
    const rpc = await probeSupabase(
      fetcher,
      supabaseUrl,
      serviceRoleKey,
      "/rest/v1/rpc/worldcons_provider_sources_v1",
      {},
      5_000,
    );
    const healthy = rest.ok && rpc.ok;
    return c.json({
      schemaVersion: 1,
      service: "worldcons-search",
      status: healthy ? "healthy" : "unhealthy",
      configured,
      supabaseHost,
      rest,
      rpc,
    }, healthy ? 200 : 503, {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
  };
  app.get("/internal/upstream-probe", upstreamProbe);

  // This Worker is internal-only (workers_dev=false, no public route). Public
  // rate limiting stays at the caller boundary before a Service Binding call.
  // Keep the provider contract byte-for-byte compatible during M9 canary.
  app.all("/api/*", (c) => handleWorldconsSearchRequest(
    c.req.raw,
    providerEnvFromSearchWorkerBindings(c.env),
    { ...dependencies.provider, coreBinding: c.env.WORLDCONS_CORE },
  ));

  app.post("/internal/cclmetasearch/search", async (c) => {
    let input: CclMetasearchSearchInput;
    try {
      const body = await c.req.json<Record<string, unknown>>();
      input = internalCclMetasearchInput(body);
    } catch {
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "INVALID_REQUEST", retryable: false },
      }, 400, { "Cache-Control": "no-store" });
    }

    try {
      const page = dependencies.cclMetasearchSearch
        ? await dependencies.cclMetasearchSearch(input, c.env)
        : await searchCclMetasearchWithEnv(input, {
          PUBLIC_SITE_BASE_URL: c.env.PUBLIC_SITE_BASE_URL?.trim() || "https://worldcons.vercel.app",
          CORE_BINDING: c.env.WORLDCONS_CORE,
          SEARCH_BINDING: c.env.WORLDCONS_SEARCH,
          CCL_METASEARCH_DB_TIMEOUT_MS: c.env.CCL_METASEARCH_DB_TIMEOUT_MS,
        }, dependencies.cclMetasearchDependencies);
      return c.json(page, 200, {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_search_service_cclmetasearch_error",
        error: error instanceof Error ? error.name : "UnknownError",
      }));
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "SERVICE_UNAVAILABLE", retryable: true },
      }, 503, {
        "Cache-Control": "no-store",
        "Retry-After": "30",
        "X-Content-Type-Options": "nosniff",
      });
    }
  });

  app.post("/internal/site-events/write", async (c) => {
    let row: BoundSiteEventWriteRow;
    try {
      row = internalSiteEventWriteInput(await c.req.json<Record<string, unknown>>());
    } catch {
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "INVALID_REQUEST", retryable: false },
      }, 400, { "Cache-Control": "no-store" });
    }

    try {
      if (dependencies.siteEventWrite) {
        await dependencies.siteEventWrite(row, c.env);
      } else {
        await writeSiteEventToSupabase(
          dependencies.provider?.fetcher ?? fetch,
          c.env,
          row,
        );
      }
      return new Response(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_search_service_site_event_write_error",
        error: error instanceof Error ? error.name : "UnknownError",
      }));
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "SERVICE_UNAVAILABLE", retryable: true },
      }, 503, {
        "Cache-Control": "no-store",
        "Retry-After": "30",
        "X-Content-Type-Options": "nosniff",
      });
    }
  });

  app.post("/internal/admin-audit/write", async (c) => {
    let row: BoundAdminAuditWriteRow;
    try {
      row = internalAdminAuditWriteInput(await c.req.json<Record<string, unknown>>());
    } catch {
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "INVALID_REQUEST", retryable: false },
      }, 400, { "Cache-Control": "no-store" });
    }
    try {
      if (dependencies.adminAuditWrite) {
        await dependencies.adminAuditWrite(row, c.env);
      } else {
        await writeSupabaseRow(
          dependencies.provider?.fetcher ?? fetch,
          c.env,
          "admin_audit_logs",
          row,
          {
            notConfigured: "admin_audit_supabase_not_configured",
            writeFailed: "admin_audit_supabase_write_failed",
          },
        );
      }
      return new Response(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_search_service_admin_audit_write_error",
        error: error instanceof Error ? error.name : "UnknownError",
      }));
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "SERVICE_UNAVAILABLE", retryable: true },
      }, 503, {
        "Cache-Control": "no-store",
        "Retry-After": "30",
        "X-Content-Type-Options": "nosniff",
      });
    }
  });

  app.post("/internal/admin-article-edit/write", async (c) => {
    let row: BoundAdminArticleEditWriteRow;
    try {
      row = internalAdminArticleEditWriteInput(await c.req.json<Record<string, unknown>>());
    } catch {
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "INVALID_REQUEST", retryable: false },
      }, 400, { "Cache-Control": "no-store" });
    }
    try {
      if (dependencies.adminArticleEditWrite) {
        await dependencies.adminArticleEditWrite(row, c.env);
      } else {
        await writeSupabaseRow(
          dependencies.provider?.fetcher ?? fetch,
          c.env,
          "admin_article_edit_history",
          row,
          {
            notConfigured: "admin_article_edit_supabase_not_configured",
            writeFailed: "admin_article_edit_supabase_write_failed",
          },
        );
      }
      return new Response(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_search_service_admin_article_edit_write_error",
        error: error instanceof Error ? error.name : "UnknownError",
      }));
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "SERVICE_UNAVAILABLE", retryable: true },
      }, 503, {
        "Cache-Control": "no-store",
        "Retry-After": "30",
        "X-Content-Type-Options": "nosniff",
      });
    }
  });

  app.post("/internal/ops-heartbeat/write", async (c) => {
    let row: OpsHeartbeatWriteRow;
    try {
      const parsed = parseOpsHeartbeatWriteRow(await c.req.json<Record<string, unknown>>());
      if (!parsed.ok) {
        return c.json({
          schemaVersion: 1,
          service: "worldcons-search",
          error: { code: "INVALID_REQUEST", reason: parsed.error, retryable: false },
        }, 400, { "Cache-Control": "no-store" });
      }
      row = parsed.row;
    } catch {
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "INVALID_REQUEST", retryable: false },
      }, 400, { "Cache-Control": "no-store" });
    }
    try {
      if (dependencies.opsHeartbeatWrite) {
        await dependencies.opsHeartbeatWrite(row, c.env);
      } else {
        await writeOpsHeartbeatToSupabase(
          dependencies.provider?.fetcher ?? fetch,
          c.env,
          row,
        );
      }
      return new Response(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_search_service_ops_heartbeat_write_error",
        error: error instanceof Error ? error.name : "UnknownError",
      }));
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "SERVICE_UNAVAILABLE", retryable: true },
      }, 503, {
        "Cache-Control": "no-store",
        "Retry-After": "30",
        "X-Content-Type-Options": "nosniff",
      });
    }
  });

  // M11.4 admin_ops_events internal Supabase compatibility bridge. The
  // service-role credential stays in this internal Worker; the boundary never
  // holds it. Insert/prune use PostgREST table writes; latest is a bounded
  // descending read. Every body is validated by the shared runtime-neutral
  // parser before it reaches Supabase.
  app.post(ADMIN_OPS_EVENTS_SEARCH_PATH, async (c) => {
    let row: AdminOpsEventWriteRow;
    try {
      const parsed = parseAdminOpsEventWriteRow(await c.req.json<Record<string, unknown>>());
      if (!parsed.ok) {
        return c.json({
          schemaVersion: 1,
          service: "worldcons-search",
          error: { code: "INVALID_REQUEST", reason: parsed.error, retryable: false },
        }, 400, { "Cache-Control": "no-store" });
      }
      row = parsed.row;
    } catch {
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "INVALID_REQUEST", retryable: false },
      }, 400, { "Cache-Control": "no-store" });
    }
    try {
      if (dependencies.adminOpsEventWrite) {
        await dependencies.adminOpsEventWrite(row, c.env);
      } else {
        await writeAdminOpsEventToSupabase(dependencies.provider?.fetcher ?? fetch, c.env, row);
      }
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_search_service_admin_ops_event_write_error",
        error: error instanceof Error ? error.name : "UnknownError",
      }));
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "SERVICE_UNAVAILABLE", retryable: true },
      }, 503, {
        "Cache-Control": "no-store",
        "Retry-After": "30",
        "X-Content-Type-Options": "nosniff",
      });
    }
  });

  app.get(ADMIN_OPS_EVENTS_SEARCH_LATEST_PATH, async (c) => {
    try {
      const event = dependencies.adminOpsEventLatestRead
        ? await dependencies.adminOpsEventLatestRead(c.env)
        : await readLatestAdminOpsEventFromSupabase(dependencies.provider?.fetcher ?? fetch, c.env);
      return c.json({ schemaVersion: 1, service: "worldcons-search", event }, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_search_service_admin_ops_event_latest_error",
        error: error instanceof Error ? error.name : "UnknownError",
      }));
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "SERVICE_UNAVAILABLE", retryable: true },
      }, 503, { "Cache-Control": "no-store", "Retry-After": "30" });
    }
  });

  app.post(ADMIN_OPS_EVENTS_SEARCH_PRUNE_PATH, async (c) => {
    let cutoff: unknown;
    try {
      cutoff = (await c.req.json<Record<string, unknown>>()).cutoff;
    } catch {
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "INVALID_REQUEST", retryable: false },
      }, 400, { "Cache-Control": "no-store" });
    }
    if (typeof cutoff !== "string" || cutoff.length === 0 || cutoff.length > 64 || !Number.isFinite(Date.parse(cutoff))) {
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "INVALID_REQUEST", reason: "invalid_cutoff", retryable: false },
      }, 400, { "Cache-Control": "no-store" });
    }
    try {
      if (dependencies.adminOpsEventPrune) {
        await dependencies.adminOpsEventPrune(cutoff, c.env);
      } else {
        await pruneAdminOpsEventsInSupabase(dependencies.provider?.fetcher ?? fetch, c.env, cutoff);
      }
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "worldcons_search_service_admin_ops_event_prune_error",
        error: error instanceof Error ? error.name : "UnknownError",
      }));
      return c.json({
        schemaVersion: 1,
        service: "worldcons-search",
        error: { code: "SERVICE_UNAVAILABLE", retryable: true },
      }, 503, { "Cache-Control": "no-store", "Retry-After": "30" });
    }
  });

  app.all("*", (c) => c.json({
    schemaVersion: 1,
    service: "worldcons-search",
    error: {
      code: "NOT_FOUND",
      message: "The requested internal search service endpoint does not exist.",
      retryable: false,
    },
  }, 404, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }));

  return app;
}

async function probeSupabase(
  fetcher: typeof fetch,
  baseUrl: string,
  serviceRoleKey: string,
  pathname: string,
  body: Record<string, unknown> | undefined,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  try {
    const endpoint = new URL(pathname, baseUrl);
    const response = await fetcher(endpoint, {
      method: body ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return {
      ok: response.ok,
      status: response.status,
      error: response.ok ? null : "http_error",
      ms: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.name : "UnknownError",
      ms: Date.now() - startedAt,
    };
  }
}

function internalCclMetasearchInput(body: Record<string, unknown>) {
  if (
    typeof body.query !== "string"
    || !Number.isSafeInteger(body.limit)
    || !Number.isSafeInteger(body.offset)
    || (body.sort !== "relevance" && body.sort !== "latest")
  ) {
    throw new Error("invalid internal cclmetasearch request");
  }
  const params = new URLSearchParams({
    q: body.query,
    limit: String(body.limit),
    offset: String(body.offset),
    sort: body.sort,
  });
  return parseCclMetasearchSearchParams(params);
}

const SITE_EVENT_TYPE_SET = new Set<string>(SITE_EVENT_TYPE_VALUES);

function internalSiteEventWriteInput(body: Record<string, unknown>): BoundSiteEventWriteRow {
  if (!SITE_EVENT_TYPE_SET.has(stringField(body.event_type))) {
    throw new Error("invalid event type");
  }
  const metadata = body.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("invalid metadata");
  }
  const resultCount = nullableInteger(body.result_count);
  return {
    event_type: stringField(body.event_type),
    path: nullableString(body.path),
    article_id: nullableString(body.article_id),
    article_slug: nullableString(body.article_slug),
    article_title: nullableString(body.article_title),
    tag_slug: nullableString(body.tag_slug),
    tag_name: nullableString(body.tag_name),
    source_key: nullableString(body.source_key),
    jurisdiction: nullableString(body.jurisdiction),
    institution_name: nullableString(body.institution_name),
    search_query: nullableString(body.search_query),
    search_mode: nullableString(body.search_mode),
    result_count: resultCount,
    referrer_host: nullableString(body.referrer_host),
    user_agent_family: nullableString(body.user_agent_family),
    device_type: nullableString(body.device_type),
    client_ip_hash: nullableString(body.client_ip_hash),
    accept_language: nullableString(body.accept_language),
    client_country: nullableString(body.client_country),
    is_bot: booleanField(body.is_bot),
    metadata: metadata as Record<string, unknown>,
  };
}

function internalAdminAuditWriteInput(body: Record<string, unknown>): BoundAdminAuditWriteRow {
  const metadata = body.redacted_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("invalid metadata");
  }
  return {
    actor_id: nullableString(body.actor_id),
    actor_role: nullableString(body.actor_role),
    action: stringField(body.action),
    target_type: nullableString(body.target_type),
    target_id: nullableString(body.target_id),
    article_id: nullableString(body.article_id),
    article_slug: nullableString(body.article_slug),
    source_key: nullableString(body.source_key),
    job_id: nullableString(body.job_id),
    result: nullableString(body.result),
    error_class: nullableString(body.error_class),
    redacted_metadata: metadata as Record<string, unknown>,
    request_ip_hash: nullableString(body.request_ip_hash),
    user_agent_family: nullableString(body.user_agent_family),
  };
}

function internalAdminArticleEditWriteInput(body: Record<string, unknown>): BoundAdminArticleEditWriteRow {
  const diff = body.diff_redacted;
  if (!diff || typeof diff !== "object" || Array.isArray(diff)) {
    throw new Error("invalid diff_redacted");
  }
  if (!Array.isArray(body.changed_fields) || !body.changed_fields.every((field) => typeof field === "string")) {
    throw new Error("invalid changed_fields");
  }
  return {
    article_id: stringField(body.article_id),
    article_slug: nullableString(body.article_slug),
    actor_id: nullableString(body.actor_id),
    changed_fields: body.changed_fields,
    previous_summary_hash: nullableString(body.previous_summary_hash),
    next_summary_hash: nullableString(body.next_summary_hash),
    diff_redacted: diff as Record<string, unknown>,
  };
}

function stringField(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid string");
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("invalid nullable string");
  return value;
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("invalid integer");
  return Number(value);
}

function booleanField(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("invalid boolean");
  return value;
}

async function writeOpsHeartbeatToSupabase(
  fetcher: typeof fetch,
  env: WorldconsSearchWorkerEnv,
  row: OpsHeartbeatWriteRow,
) {
  const supabaseUrl = env.SUPABASE_URL?.trim() || "";
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("ops_heartbeat_supabase_not_configured");
  }
  // `ops_workflow_heartbeats` only grants service_role SELECT on the table; the
  // authorized write path is the SECURITY DEFINER `ops_workflow_heartbeat_v1`
  // RPC. Call it directly rather than inserting into the table.
  const endpoint = new URL("/rest/v1/rpc/ops_workflow_heartbeat_v1", supabaseUrl);
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      p_workflow_key: row.workflow_key,
      p_status: row.status,
      p_run_id: row.run_id,
      p_detail: row.detail,
      p_observed_at: row.observed_at,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload !== true) {
    throw new Error("ops_heartbeat_supabase_write_failed");
  }
}

async function writeAdminOpsEventToSupabase(
  fetcher: typeof fetch,
  env: WorldconsSearchWorkerEnv,
  row: AdminOpsEventWriteRow,
) {
  const supabaseUrl = env.SUPABASE_URL?.trim() || "";
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!supabaseUrl || !serviceRoleKey) throw new Error("admin_ops_events_supabase_not_configured");
  const endpoint = new URL("/rest/v1/admin_ops_events", supabaseUrl);
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Prefer: "return=minimal",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("admin_ops_events_supabase_write_failed");
}

async function readLatestAdminOpsEventFromSupabase(
  fetcher: typeof fetch,
  env: WorldconsSearchWorkerEnv,
): Promise<AdminOpsEventRecord | null> {
  const supabaseUrl = env.SUPABASE_URL?.trim() || "";
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!supabaseUrl || !serviceRoleKey) throw new Error("admin_ops_events_supabase_not_configured");
  const endpoint = new URL("/rest/v1/admin_ops_events", supabaseUrl);
  endpoint.searchParams.set("select", "id,event_type,severity,source_key,summary,detail,created_at");
  endpoint.searchParams.set("order", "created_at.desc");
  endpoint.searchParams.set("limit", "1");
  const response = await fetcher(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("admin_ops_events_supabase_read_failed");
  }
  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload) || payload.length === 0) return null;
  return parseAdminOpsEventRecord(payload[0]);
}

async function pruneAdminOpsEventsInSupabase(
  fetcher: typeof fetch,
  env: WorldconsSearchWorkerEnv,
  cutoff: string,
) {
  const supabaseUrl = env.SUPABASE_URL?.trim() || "";
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!supabaseUrl || !serviceRoleKey) throw new Error("admin_ops_events_supabase_not_configured");
  const endpoint = new URL("/rest/v1/admin_ops_events", supabaseUrl);
  endpoint.searchParams.set("created_at", `lt.${cutoff}`);
  const response = await fetcher(endpoint, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      Prefer: "return=minimal",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("admin_ops_events_supabase_prune_failed");
}

async function writeSiteEventToSupabase(
  fetcher: typeof fetch,
  env: WorldconsSearchWorkerEnv,
  row: BoundSiteEventWriteRow,
) {
  await writeSupabaseRow(fetcher, env, "site_events", row, {
    notConfigured: "site_event_supabase_not_configured",
    writeFailed: "site_event_supabase_write_failed",
  });
}

interface SupabaseWriteErrorCodes {
  notConfigured: string;
  writeFailed: string;
}

async function writeSupabaseRow(
  fetcher: typeof fetch,
  env: WorldconsSearchWorkerEnv,
  table: "site_events" | "admin_audit_logs" | "admin_article_edit_history",
  row: BoundSiteEventWriteRow | BoundAdminAuditWriteRow | BoundAdminArticleEditWriteRow,
  errors: SupabaseWriteErrorCodes,
) {
  const supabaseUrl = env.SUPABASE_URL?.trim() || "";
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(errors.notConfigured);
  }
  const endpoint = new URL(`/rest/v1/${table}`, supabaseUrl);
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Prefer: "return=minimal",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(errors.writeFailed);
}

const app = createWorldconsSearchServiceApp();

export default app;
