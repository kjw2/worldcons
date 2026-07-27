import { NextResponse } from "next/server";
import { listSources } from "@/lib/db/queries";
import { consumeRateLimit, rateLimitExceededResponse } from "@/lib/security/rate-limit";
import {
  mapSearchApiSource,
  WORLDCONS_SEARCH_SCHEMA_VERSION,
} from "@/lib/search/api-contract";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const rateLimit = consumeRateLimit(request, "publicApi");
  if (rateLimit?.limited) {
    return rateLimitExceededResponse(rateLimit);
  }

  try {
    const sources = await listSources();
    return NextResponse.json(
      {
        schemaVersion: WORLDCONS_SEARCH_SCHEMA_VERSION,
        service: "worldcons",
        items: sources.map(mapSearchApiSource),
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900",
        },
      },
    );
  } catch (error) {
    console.error("[sources-api] source inventory unavailable", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json(
      {
        schemaVersion: WORLDCONS_SEARCH_SCHEMA_VERSION,
        service: "worldcons",
        error: "Source inventory temporarily unavailable",
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": "30",
        },
      },
    );
  }
}
