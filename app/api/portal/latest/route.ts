import { NextResponse } from "next/server";
import { listArticles } from "@/lib/db/queries";
import type { ArticleListItem } from "@/lib/db/types";
import { getAppBaseUrl } from "@/lib/seo/metadata";
import { displayArticleTypeLabel } from "@/lib/ui/content-type-labels";
import { displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";
import { boundedInteger } from "@/lib/utils/numbers";
import { safeExternalUrl } from "@/lib/utils/safe-url";
import { portalAuthFailureStatus } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const JURISDICTION_CODES: Record<string, string> = {
  "United States": "US",
  Germany: "DE",
  France: "FR",
  Spain: "ES",
};

function isoOrNull(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function firstIso(values: Array<string | null | undefined>, fallback: string) {
  return values.map(isoOrNull).find(Boolean) ?? fallback;
}

function portalItem(article: ArticleListItem, baseUrl: string, fallbackUpdatedAt: string) {
  const jurisdictionName = displayJurisdictionLabel(article.jurisdiction);
  const type = displayArticleTypeLabel(article);
  const updatedAt = firstIso([article.summarizedAt, article.fetchedAt, article.discoveredAt, article.originalPublishedAt], fallbackUpdatedAt);
  const publishedAt = firstIso([article.originalPublishedAt, article.discoveredAt, article.fetchedAt, article.summarizedAt], updatedAt);
  const sourceName = displaySourceLabel({ sourceKey: article.sourceKey, name: article.institutionName });
  const externalUrl = safeExternalUrl(article.originalUrl) ?? undefined;

  return {
    id: article.id ?? article.slug,
    canonicalId: `worldcons:${article.slug}`,
    title: article.koreanTitle || article.originalTitle || "제목 미상",
    subtitle: article.oneLineSummary || "",
    type,
    jurisdictionCode: JURISDICTION_CODES[article.jurisdiction] ?? article.jurisdiction,
    jurisdictionName,
    sourceName,
    publishedAt,
    updatedAt,
    language: "ko",
    url: `${baseUrl}/articles/${article.slug}`,
    externalUrl,
    badges: [jurisdictionName, type].filter(Boolean),
  };
}

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
      items: result.items.map((article) => portalItem(article, baseUrl, updatedAt)),
    },
    {
      headers: {
        "Cache-Control": "private, no-store",
      },
    },
  );
}
