import { NextResponse } from "next/server";
import { listArticles } from "@/lib/db/queries";
import type { ArticleContentType } from "@/lib/db/types";
import { ARTICLE_CONTENT_TYPES } from "@/lib/db/types";
import { normalizeRange } from "@/lib/utils/dates";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const result = await listArticles({
    q: searchParams.get("q") ?? undefined,
    range: normalizeRange(searchParams.get("range")),
    source: searchParams.get("source") ?? undefined,
    jurisdiction: searchParams.get("jurisdiction") ?? undefined,
    type: ARTICLE_CONTENT_TYPES.includes(type as ArticleContentType) ? (type as ArticleContentType) : undefined,
    tag: searchParams.get("tag") ?? undefined,
    language: searchParams.get("language") ?? undefined,
    page: Number(searchParams.get("page") ?? 1),
    pageSize: Number(searchParams.get("pageSize") ?? 20),
  });

  return NextResponse.json(result);
}
