import {
  handleWorldconsSearchRequest,
  providerRateLimitExceededResponse,
} from "@/lib/integrations/cclrag2/provider-handler";
import { consumeRateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Public discovery alias for the provider contract at /api/cclrag2. */
export async function GET(request: Request) {
  const rateLimit = await consumeRateLimit(request, "publicApi");
  if (rateLimit?.limited) {
    return providerRateLimitExceededResponse(request, rateLimit.retryAfterSeconds);
  }
  return handleWorldconsSearchRequest(request, {
    ENVIRONMENT: "contract-discovery",
    PUBLIC_BASE_URL: "https://worldcons.cclib.workers.dev/api/cclrag2",
  });
}
