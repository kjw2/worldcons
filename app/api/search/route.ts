import { NextResponse } from "next/server";
import { recordSearchEvent } from "@/lib/analytics/events";
import { listArticles } from "@/lib/db/queries";
import type { ArticleContentType } from "@/lib/db/types";
import { ARTICLE_CONTENT_TYPES } from "@/lib/db/types";
import { semanticSearch, hybridSearch } from "@/lib/search/vector";
import { normalizeRange } from "@/lib/utils/dates";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const modeParam = searchParams.get("mode");
  const mode = modeParam === "fulltext" || modeParam === "semantic" || modeParam === "hybrid" ? modeParam : "hybrid";
  const filters = {
    q: searchParams.get("q") ?? undefined,
    range: normalizeRange(searchParams.get("range")),
    source: searchParams.get("source") ?? undefined,
    jurisdiction: searchParams.get("jurisdiction") ?? undefined,
    type: ARTICLE_CONTENT_TYPES.includes(type as ArticleContentType) ? (type as ArticleContentType) : undefined,
    tag: searchParams.get("tag") ?? undefined,
    language: searchParams.get("language") ?? undefined,
    page: Number(searchParams.get("page") ?? 1),
    pageSize: Number(searchParams.get("pageSize") ?? 20),
  };
  const result = mode === "semantic" ? await semanticSearch(filters) : mode === "hybrid" ? await hybridSearch(filters) : await listArticles(filters);
  await recordSearchEvent({
    query: filters.q,
    mode,
    resultCount: result.pageInfo.total,
    path: "/api/search",
    headers: request.headers,
    metadata: {
      source: filters.source,
      jurisdiction: filters.jurisdiction,
      tag: filters.tag,
      language: filters.language,
      type: filters.type,
      page: filters.page,
    },
  });

  return NextResponse.json({ ...result, mode });
}
