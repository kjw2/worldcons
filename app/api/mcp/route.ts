import {
  handleWorldconsMcpRequest,
  mcpMethodNotAllowed,
  mcpOptionsResponse,
  mcpRateLimitExceeded,
} from "@/lib/chatgpt-plugin/http-handler";
import { consumeRateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

export async function POST(request: Request) {
  const rateLimit = await consumeRateLimit(request, "publicApi");
  if (rateLimit?.limited) return mcpRateLimitExceeded(rateLimit.retryAfterSeconds);
  return handleWorldconsMcpRequest(request);
}

export async function GET() {
  return mcpMethodNotAllowed();
}

export async function DELETE() {
  return mcpMethodNotAllowed();
}

export async function OPTIONS() {
  return mcpOptionsResponse();
}
