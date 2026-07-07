import { NextResponse } from "next/server";
import {
  listAdminArticles,
  type AdminArticleListFilters,
  type AdminArticlePublishableFilter,
  type AdminArticleSummaryFilter,
} from "@/lib/db/admin-queries";
import { isAuthorizedRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PUBLISHABLE_FILTERS = new Set<AdminArticlePublishableFilter>(["all", "yes", "no"]);
const SUMMARY_FILTERS = new Set<AdminArticleSummaryFilter>(["all", "yes", "no"]);

function textParam(params: URLSearchParams, key: string) {
  const value = params.get(key)?.trim();
  return value ? value.slice(0, 200) : undefined;
}

function numberParam(params: URLSearchParams, key: string) {
  const value = Number(params.get(key));
  return Number.isFinite(value) ? value : undefined;
}

function parseFilters(params: URLSearchParams): AdminArticleListFilters {
  const publishable = params.get("publishable")?.trim() as AdminArticlePublishableFilter | undefined;
  const hasSummary = params.get("hasSummary")?.trim() as AdminArticleSummaryFilter | undefined;

  return {
    q: textParam(params, "q"),
    status: textParam(params, "status"),
    sourceKey: textParam(params, "sourceKey"),
    jurisdiction: textParam(params, "jurisdiction"),
    publishable: publishable && PUBLISHABLE_FILTERS.has(publishable) ? publishable : "all",
    hasSummary: hasSummary && SUMMARY_FILTERS.has(hasSummary) ? hasSummary : "all",
    page: numberParam(params, "page"),
    pageSize: numberParam(params, "pageSize"),
  };
}

export async function GET(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await listAdminArticles(parseFilters(new URL(request.url).searchParams));
  return NextResponse.json(result);
}
