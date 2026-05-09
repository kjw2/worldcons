import { NextResponse } from "next/server";
import { listSources } from "@/lib/db/queries";

export async function GET() {
  const sources = await listSources();
  return NextResponse.json({ items: sources });
}
