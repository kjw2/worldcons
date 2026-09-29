import {
  handleWorldconsSearchRequest,
  providerRateLimitExceededResponse,
  providerServiceUnavailableResponse,
  type Cclrag2ProviderEnv,
} from "@/lib/integrations/cclrag2/provider-handler";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import { getRuntimeWorldconsSearchServiceEnv } from "@/lib/cloudflare/services/worldcons-search-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

const PUBLIC_BASE_URL = "https://worldcons.soltera.dev/api/cclrag2";

export async function GET(request: Request) {
  const rateLimit = await consumeRateLimit(request, "publicApi");
  if (rateLimit?.limited) {
    return providerRateLimitExceededResponse(request, rateLimit.retryAfterSeconds);
  }

  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api\/cclrag2(?=\/|$)/u, "/api");
  const providerRequest = new Request(url, request);
  const runtimeEnv = getRuntimeWorldconsSearchServiceEnv();
  const dependencies = runtimeEnv ? {
    coreBinding: getRuntimeD1Binding("worldcons_core"),
    searchBinding: getRuntimeD1Binding("worldcons_search"),
    vectorBinding: runtimeEnv.WORLDCONS_SEARCH_VECTOR,
  } : undefined;
  return handleWorldconsSearchRequest(
    providerRequest,
    runtimeEnv ? {
      ENVIRONMENT: runtimeEnv.ENVIRONMENT?.trim() || "production",
      PUBLIC_BASE_URL: runtimeEnv.PUBLIC_BASE_URL?.trim() || PUBLIC_BASE_URL,
      EMBEDDING_PROVIDER: runtimeEnv.EMBEDDING_PROVIDER,
      SEMANTIC_SEARCH_ENABLED: runtimeEnv.SEMANTIC_SEARCH_ENABLED,
      GEMINI_API_KEY: runtimeEnv.GEMINI_API_KEY,
      GEMINI_EMBEDDING_MODEL: runtimeEnv.GEMINI_EMBEDDING_MODEL,
    } : providerEnv(),
    dependencies,
  );
}

function providerEnv(): Cclrag2ProviderEnv {
  return {
    ENVIRONMENT: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    PUBLIC_BASE_URL,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    SEMANTIC_SEARCH_ENABLED: process.env.SEMANTIC_SEARCH_ENABLED,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_EMBEDDING_MODEL: process.env.GEMINI_EMBEDDING_MODEL,
  };
}
