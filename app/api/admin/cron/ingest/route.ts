import { NextResponse } from "next/server";
import { runIngest, runRefreshTagCounts, runSummarizePending } from "@/lib/ingest/run";
import { isAuthorizedRequest } from "@/lib/utils/auth";

export async function GET(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ingest = await runIngest({ limit: Number(process.env.INGEST_LIMIT_PER_SOURCE ?? 5) });
  const summarize = await runSummarizePending({ limit: Number(process.env.CRON_SUMMARY_LIMIT ?? 20) });
  const tags = await runRefreshTagCounts();

  return NextResponse.json({ ingest, summarize, tags });
}
