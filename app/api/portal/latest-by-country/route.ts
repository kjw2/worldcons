import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";
import { listArticles, listSources } from "@/lib/db/queries";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { displayJurisdictionLabel } from "@/lib/ui/source-labels";
import { portalAuthFailureStatus } from "@/lib/utils/auth";
import { boundedInteger } from "@/lib/utils/numbers";
import {
  jurisdictionCodeFor,
  portalArticlePublishedAt,
  toWorldlawsPortalItem,
} from "@/lib/portal/worldlaws";

export const dynamic = "force-dynamic";
export const revalidate = 0;
const PORTAL_CACHE_SECONDS = 300;

function authErrorResponse(status: number) {
  const error = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Portal token is not configured";
  return NextResponse.json({ error }, { status });
}

const getLatestByCountryPortalPayload = unstable_cache(
  async (countryLimit: number, itemLimit: number) => {
    const updatedAt = new Date().toISOString();
    const baseUrl = getAppBaseUrl();
    const sources = await listSources();
    const jurisdictions = Array.from(
      new Set(
        sources
          .filter((source) => source.isActive)
          .map((source) => source.jurisdiction)
          .filter(Boolean),
      ),
    );

    const countryResults = await Promise.all(
      jurisdictions.map(async (jurisdiction) => {
        const result = await listArticles({ jurisdiction, page: 1, pageSize: itemLimit, count: "none", includeViewCounts: false });
        const items = result.items;
        if (items.length === 0) return null;

        return {
          latestAt: portalArticlePublishedAt(items[0], updatedAt),
          jurisdictionCode: jurisdictionCodeFor(jurisdiction),
          jurisdictionName: displayJurisdictionLabel(jurisdiction),
          items: items.map((article) =>
            toWorldlawsPortalItem(article, baseUrl, updatedAt, {
              type: "constitutional_case",
              badges: [displayJurisdictionLabel(article.jurisdiction)],
            }),
          ),
        };
      }),
    );

    const countries = countryResults
      .filter((country): country is NonNullable<typeof country> => Boolean(country))
      .sort((left, right) => right.latestAt.localeCompare(left.latestAt))
      .slice(0, countryLimit)
      .map((country) => ({
        jurisdictionCode: country.jurisdictionCode,
        jurisdictionName: country.jurisdictionName,
        items: country.items,
      }));

    return {
      schemaVersion: 1,
      service: "worldcons",
      title: "헌법 판례",
      updatedAt,
      countries,
    };
  },
  ["worldlaws-portal-latest-by-country-v2"],
  { revalidate: PORTAL_CACHE_SECONDS },
);

export async function GET(request: Request) {
  const authFailureStatus = portalAuthFailureStatus(request);
  if (authFailureStatus !== null) {
    return authErrorResponse(authFailureStatus);
  }

  const { searchParams } = new URL(request.url);
  const countryLimit = boundedInteger(searchParams.get("countryLimit"), 4, { min: 1, max: 10 });
  const itemLimit = boundedInteger(searchParams.get("itemLimit"), 5, { min: 1, max: 50 });

  return NextResponse.json(
    await getLatestByCountryPortalPayload(countryLimit, itemLimit),
    {
      headers: {
        "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
      },
    },
  );
}
