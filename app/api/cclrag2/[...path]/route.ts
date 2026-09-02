import {
  handleWorldconsSearchRequest,
  providerRateLimitExceededResponse,
  type Cclrag2ProviderEnv,
} from "@/lib/integrations/cclrag2/provider-handler";
import { consumeRateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

const PUBLIC_BASE_URL = "https://worldcons.vercel.app/api/cclrag2";

export async function GET(request: Request) {
  const rateLimit = await consumeRateLimit(request, "publicApi");
  if (rateLimit?.limited) {
    return providerRateLimitExceededResponse(request, rateLimit.retryAfterSeconds);
  }

  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api\/cclrag2(?=\/|$)/u, "/api");
  return handleWorldconsSearchRequest(new Request(url, request), providerEnv());
}

function providerEnv(): Cclrag2ProviderEnv {
  return {
    ENVIRONMENT: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    PUBLIC_BASE_URL,
    SUPABASE_URL: process.env.SUPABASE_URL ?? "",
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    SEMANTIC_SEARCH_ENABLED: process.env.SEMANTIC_SEARCH_ENABLED,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_EMBEDDING_MODEL: process.env.GEMINI_EMBEDDING_MODEL,
  };
}
