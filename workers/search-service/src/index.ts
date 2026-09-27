import { Hono } from "hono";
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

  // This Worker is internal-only (workers_dev=false, no public route). Public
  // rate limiting stays at the caller boundary before a Service Binding call.
  // Keep the provider contract byte-for-byte compatible during M9 canary.
  app.all("/api/*", (c) => handleWorldconsSearchRequest(
    c.req.raw,
    providerEnvFromSearchWorkerBindings(c.env),
    dependencies.provider,
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
          SUPABASE_URL: c.env.SUPABASE_URL?.trim() || "",
          SUPABASE_SERVICE_ROLE_KEY: c.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "",
          PUBLIC_SITE_BASE_URL: c.env.PUBLIC_SITE_BASE_URL?.trim() || "https://worldcons.vercel.app",
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
