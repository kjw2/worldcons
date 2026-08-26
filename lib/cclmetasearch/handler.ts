import { NextResponse } from "next/server";
import { cclMetasearchAuthFailure, configuredCclMetasearchToken } from "@/lib/cclmetasearch/auth";
import {
  CclMetasearchRequestError,
  parseCclMetasearchSearchParams,
  type CclMetasearchSearchInput,
  type CclMetasearchSearchPage,
} from "@/lib/cclmetasearch/contract";
import { searchCclMetasearch } from "@/lib/cclmetasearch/search";
import { consumeRateLimit, type RateLimitResult } from "@/lib/security/rate-limit";

type SearchExecutor = (input: CclMetasearchSearchInput) => Promise<CclMetasearchSearchPage>;
type RateLimitConsumer = (request: Request) => RateLimitResult | null | Promise<RateLimitResult | null>;

type HandlerOptions = {
  getExpectedToken?: () => string | null;
  search?: SearchExecutor;
  consumeRateLimit?: RateLimitConsumer;
};

const SUCCESS_CACHE_CONTROL = "private, max-age=60, stale-while-revalidate=300";
const TOKEN_VARY_HEADER = "X-CCL-Metasearch-Token";

export function createCclMetasearchSearchHandler(options: HandlerOptions = {}) {
  const getExpectedToken = options.getExpectedToken ?? configuredCclMetasearchToken;
  const search = options.search ?? searchCclMetasearch;
  const rateLimitConsumer = options.consumeRateLimit ?? ((request) => consumeRateLimit(request, "cclMetasearch"));

  return async function handleCclMetasearchSearch(request: Request) {
    const authFailure = cclMetasearchAuthFailure(request, getExpectedToken());
    if (authFailure) {
      return errorResponse(authFailure.status, authFailure.code, authFailure.message, {
        retryAfterSeconds: authFailure.status === 503 ? 30 : undefined,
      });
    }

    const rateLimit = await rateLimitConsumer(request);
    if (rateLimit?.limited) {
      return errorResponse(429, "RATE_LIMITED", "The WorldCons search rate limit was exceeded.", {
        headers: rateLimit.headers,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
    }

    let input: CclMetasearchSearchInput;
    try {
      input = parseCclMetasearchSearchParams(new URL(request.url).searchParams);
    } catch (error) {
      if (error instanceof CclMetasearchRequestError) {
        return errorResponse(400, "INVALID_REQUEST", error.message, { headers: rateLimit?.headers });
      }
      throw error;
    }

    try {
      const page = await search(input);
      if (
        !Number.isSafeInteger(page.total) ||
        page.total < 0 ||
        page.items.length > input.limit ||
        (page.items.length > 0 && input.offset + page.items.length > page.total)
      ) {
        throw new Error("The WorldCons search layer returned an invalid page.");
      }

      return NextResponse.json(
        {
          schemaVersion: 1,
          service: "worldcons",
          query: { q: input.query, sort: input.sort },
          updatedAt: new Date().toISOString(),
          items: page.items,
          meta: {
            limit: input.limit,
            offset: input.offset,
            total: page.total,
            hasMore: input.offset + page.items.length < page.total,
          },
        },
        {
          headers: responseHeaders(SUCCESS_CACHE_CONTROL, rateLimit?.headers),
        },
      );
    } catch (error) {
      console.error("[cclmetasearch] WorldCons search unavailable", safeErrorName(error));
      return errorResponse(503, "SERVICE_UNAVAILABLE", "WorldCons search is temporarily unavailable.", {
        headers: rateLimit?.headers,
        retryAfterSeconds: 30,
      });
    }
  };
}

export const handleCclMetasearchSearch = createCclMetasearchSearchHandler();

export function cclMetasearchNotFoundResponse() {
  return errorResponse(404, "NOT_FOUND", "The requested cclmetasearch integration endpoint does not exist.");
}

function errorResponse(
  status: 400 | 401 | 403 | 404 | 429 | 503,
  code: "INVALID_REQUEST" | "AUTH_REQUIRED" | "FORBIDDEN" | "NOT_FOUND" | "RATE_LIMITED" | "SERVICE_UNAVAILABLE",
  message: string,
  options: { headers?: HeadersInit; retryAfterSeconds?: number } = {},
) {
  const headers = responseHeaders("no-store", options.headers);
  if (options.retryAfterSeconds) {
    headers.set("Retry-After", String(options.retryAfterSeconds));
  }

  return NextResponse.json(
    {
      schemaVersion: 1,
      service: "worldcons",
      error: {
        code,
        message,
        retryable: status === 429 || status === 503,
      },
    },
    { status, headers },
  );
}

function responseHeaders(cacheControl: string, extra?: HeadersInit) {
  const headers = new Headers(extra);
  headers.set("Cache-Control", cacheControl);
  headers.set("Vary", TOKEN_VARY_HEADER);
  return headers;
}

function safeErrorName(error: unknown) {
  return error instanceof Error ? error.name : "UnknownError";
}
