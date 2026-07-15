import { timingSafeEqual } from "node:crypto";
import { CCL_METASEARCH_TOKEN_HEADER } from "@/lib/cclmetasearch/contract";

export type CclMetasearchAuthFailure = {
  status: 401 | 403 | 503;
  code: "AUTH_REQUIRED" | "FORBIDDEN" | "SERVICE_UNAVAILABLE";
  message: string;
};

export function configuredCclMetasearchToken() {
  return process.env.CCL_METASEARCH_API_TOKEN?.trim() || null;
}

export function cclMetasearchAuthFailure(
  request: Request,
  expectedToken: string | null = configuredCclMetasearchToken(),
): CclMetasearchAuthFailure | null {
  if (!expectedToken) {
    return {
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "The cclmetasearch integration is not configured.",
    };
  }

  const suppliedToken = request.headers.get(CCL_METASEARCH_TOKEN_HEADER)?.trim();
  if (!suppliedToken) {
    return {
      status: 401,
      code: "AUTH_REQUIRED",
      message: `The ${CCL_METASEARCH_TOKEN_HEADER} header is required.`,
    };
  }

  if (!safeEqual(suppliedToken, expectedToken)) {
    return {
      status: 403,
      code: "FORBIDDEN",
      message: "The integration token is invalid.",
    };
  }

  return null;
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  const comparisonLength = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const paddedLeft = Buffer.alloc(comparisonLength);
  const paddedRight = Buffer.alloc(comparisonLength);
  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);

  return timingSafeEqual(paddedLeft, paddedRight) && leftBuffer.length === rightBuffer.length;
}
