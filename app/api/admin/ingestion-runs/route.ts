import { NextResponse } from "next/server";
import { listIngestionRuns } from "@/lib/db/queries";
import { isAuthorizedRequest } from "@/lib/utils/auth";

export async function GET(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get("limit") ?? 50);
  const runs = await listIngestionRuns(Number.isFinite(limit) ? limit : 50);
  return NextResponse.json({ items: runs });
}
