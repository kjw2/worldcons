import { NextResponse } from "next/server";
import { parseAdminWorkFilters } from "@/lib/admin/p4/filters";
import { getAdminWorkQueueSnapshot } from "@/lib/admin/p4/repository";
import { isAuthorizedRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const searchParams = new URL(request.url).searchParams;
  const filters = parseAdminWorkFilters(Object.fromEntries(searchParams.entries()));
  return NextResponse.json(await getAdminWorkQueueSnapshot(filters));
}

export function POST() {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405, headers: { allow: "GET" } });
}
