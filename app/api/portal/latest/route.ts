import { NextResponse } from "next/server";
import { listArticles } from "@/lib/db/queries";
import { toWorldlawsPortalItem } from "@/lib/portal/worldlaws";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { boundedInteger } from "@/lib/utils/numbers";
import { portalAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function authErrorResponse(status: number) {
  const error = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Portal token is not configured";
  return NextResponse.json({ error }, { status });
}

export async function GET(request: Request) {
  const authFailureStatus = portalAuthFailureStatus(request);
  if (authFailureStatus !== null) {
    return authErrorResponse(authFailureStatus);
  }

  const { searchParams } = new URL(request.url);
  const limit = boundedInteger(searchParams.get("limit"), 10, { min: 1, max: 50 });
  const updatedAt = new Date().toISOString();
  const result = await listArticles({ page: 1, pageSize: limit, count: "none" });
  const baseUrl = getAppBaseUrl();

  return NextResponse.json(
    {
      schemaVersion: 1,
      service: "worldcons",
      title: "헌법재판 신착",
      updatedAt,
      items: result.items.map((article) => toWorldlawsPortalItem(article, baseUrl, updatedAt)),
    },
    {
      headers: {
        "Cache-Control": "private, no-store",
      },
    },
  );
}
