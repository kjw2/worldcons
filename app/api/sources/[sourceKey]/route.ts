import { NextResponse } from "next/server";
import { getSourceByKey, listArticles } from "@/lib/db/queries";

export async function GET(_request: Request, { params }: { params: Promise<{ sourceKey: string }> }) {
  const { sourceKey } = await params;
  const source = await getSourceByKey(sourceKey);

  if (!source) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  const articles = await listArticles({ source: source.sourceKey, pageSize: 30 });
  return NextResponse.json({ source, articles });
}
