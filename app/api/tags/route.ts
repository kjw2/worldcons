import { NextResponse } from "next/server";
import { listTags } from "@/lib/db/queries";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sort = searchParams.get("sort");
  const tags = await listTags({
    type: searchParams.get("type") ?? undefined,
    sort: sort === "latest" || sort === "name" ? sort : "count",
  });

  return NextResponse.json({ items: tags });
}
