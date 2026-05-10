import { NextResponse } from "next/server";
import { getTagBySlug } from "@/lib/db/queries";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tag = await getTagBySlug(slug);

  if (!tag) {
    return NextResponse.json({ error: "Tag not found" }, { status: 404 });
  }

  return NextResponse.json(tag);
}
