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
import type { VectorizeIndexBinding } from "@/lib/cloudflare/search-vector/types";

export interface WorldconsSearchServiceEnv {
  ENVIRONMENT?: string;
  PUBLIC_BASE_URL?: string;
  EMBEDDING_PROVIDER?: string;
  SEMANTIC_SEARCH_ENABLED?: string;
  GEMINI_API_KEY?: string;
  GEMINI_EMBEDDING_MODEL?: string;
  PUBLIC_SITE_BASE_URL?: string;
  CCL_METASEARCH_DB_TIMEOUT_MS?: string;
  WORLDCONS_CORE?: D1RuntimeDatabase;
  WORLDCONS_SEARCH?: D1RuntimeDatabase;
  WORLDCONS_SEARCH_VECTOR?: VectorizeIndexBinding;
}

const DEFAULT_PUBLIC_BASE_URL = "https://worldcons.cclib.workers.dev/api/cclrag2";

interface RuntimeWorldconsSearchServiceGlobal {
  __worldconsSearchServiceEnvV1?: WorldconsSearchServiceEnv;
}

function runtimeGlobal(): typeof globalThis & RuntimeWorldconsSearchServiceGlobal {
  return globalThis as typeof globalThis & RuntimeWorldconsSearchServiceGlobal;
}

export function setRuntimeWorldconsSearchServiceEnv(env: WorldconsSearchServiceEnv | null): void {
  const target = runtimeGlobal();
  if (env) target.__worldconsSearchServiceEnvV1 = env;
  else delete target.__worldconsSearchServiceEnvV1;
}

export function getRuntimeWorldconsSearchServiceEnv(): WorldconsSearchServiceEnv | null {
  return runtimeGlobal().__worldconsSearchServiceEnvV1 ?? null;
}

export function providerEnvFromSearchServiceBindings(
  env: WorldconsSearchServiceEnv,
): Cclrag2ProviderEnv {
  return {
    ENVIRONMENT: env.ENVIRONMENT?.trim() || "production",
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL?.trim() || DEFAULT_PUBLIC_BASE_URL,
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
    env: WorldconsSearchServiceEnv,
  ) => Promise<CclMetasearchSearchPage>;
  cclMetasearchDependencies?: CclMetasearchSearchDependencies;
}

export function createWorldconsSearchServiceApp(
  dependencies: WorldconsSearchServiceDependencies = {},
) {
  const app = new Hono<{ Bindings: WorldconsSearchServiceEnv }>();

  app.get("/health", (c) => c.json({
    schemaVersion: 1,
    service: "worldcons-search",
    status: "ready",
    transport: "cloudflare-service-binding",
  }, 200, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }));

  app.get("/internal/upstream-probe", async (c) => probeD1Readiness(c));

  app.all("/api/*", (c) => handleWorldconsSearchRequest(
    c.req.raw,
    providerEnvFromSearchServiceBindings(c.env),
    {
      ...dependencies.provider,
      coreBinding: c.env.WORLDCONS_CORE,
      searchBinding: c.env.WORLDCONS_SEARCH,
      vectorBinding: c.env.WORLDCONS_SEARCH_VECTOR,
    },
  ));

  app.post("/internal/cclmetasearch/search", async (c) => {
    let input: CclMetasearchSearchInput;
    try {
      input = internalCclMetasearchInput(await c.req.json<Record<string, unknown>>());
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
          PUBLIC_SITE_BASE_URL: c.env.PUBLIC_SITE_BASE_URL?.trim() || "https://worldcons.cclib.workers.dev",
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

async function probeD1Readiness(c: Context<{ Bindings: WorldconsSearchServiceEnv }>) {
  const core = await probeD1Binding(c.env.WORLDCONS_CORE);
  const search = await probeD1Binding(c.env.WORLDCONS_SEARCH);
  const configured = {
    coreD1: Boolean(c.env.WORLDCONS_CORE),
    searchD1: Boolean(c.env.WORLDCONS_SEARCH),
    vectorize: Boolean(c.env.WORLDCONS_SEARCH_VECTOR),
    geminiApiKey: Boolean(c.env.GEMINI_API_KEY?.trim()),
  };
  const healthy = core.ok && search.ok;
  return c.json({
    schemaVersion: 1,
    service: "worldcons-search",
    status: healthy ? "healthy" : "unhealthy",
    configured,
    d1: { core, search },
  }, healthy ? 200 : 503, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
}

async function probeD1Binding(binding: D1RuntimeDatabase | undefined) {
  if (!binding) return { ok: false, error: "not_configured" };
  try {
    const result = await binding.prepare("SELECT 1 AS ready").all<{ ready: number }>();
    if (result.success === false || !Array.isArray(result.results) || result.results[0]?.ready !== 1) {
      return { ok: false, error: "query_failed" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : "UnknownError" };
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

const app = createWorldconsSearchServiceApp();

export default app;
