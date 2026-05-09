import { NextResponse } from "next/server";
import { runIngest, runRefreshTagCounts, runSummarizePending } from "@/lib/ingest/run";
import { isAuthorizedRequest } from "@/lib/utils/auth";

export async function POST(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const sourceKey = typeof body.sourceKey === "string" ? body.sourceKey : undefined;
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const summarizeLimit = typeof body.summarizeLimit === "number" ? body.summarizeLimit : limit;
  const result = await runIngest({ sourceKey, limit });
  const summarize = body.summarize === true ? await runSummarizePending({ limit: summarizeLimit }) : null;
  const tags = body.refreshTags === true || body.summarize === true ? await runRefreshTagCounts() : null;

  return NextResponse.json({ ingest: result, summarize, tags });
}
