import { Hono } from "hono";
import {
  handleWorldconsSearchRequest,
  type Cclrag2ProviderEnv,
  type ProviderDependencies,
} from "@/lib/integrations/cclrag2/provider-handler";

export interface WorldconsSearchWorkerEnv {
  ENVIRONMENT?: string;
  PUBLIC_BASE_URL?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  EMBEDDING_PROVIDER?: string;
  SEMANTIC_SEARCH_ENABLED?: string;
  GEMINI_API_KEY?: string;
  GEMINI_EMBEDDING_MODEL?: string;
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

export function createWorldconsSearchServiceApp(
  dependencies: ProviderDependencies = {},
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
    dependencies,
  ));

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

const app = createWorldconsSearchServiceApp();

export default app;
