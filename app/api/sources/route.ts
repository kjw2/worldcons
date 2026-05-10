import { NextResponse } from "next/server";
import { listSources } from "@/lib/db/queries";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const sources = await listSources();
  return NextResponse.json({ items: sources });
}
