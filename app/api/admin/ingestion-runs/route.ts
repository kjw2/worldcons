import { NextResponse } from "next/server";
import { listIngestionRuns } from "@/lib/db/queries";
import { isAuthorizedRequest } from "@/lib/utils/auth";
import { boundedInteger } from "@/lib/utils/numbers";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = boundedInteger(searchParams.get("limit"), 50, { min: 1, max: 100 });
  const runs = await listIngestionRuns(limit);
  return NextResponse.json({ items: runs });
}
