import { NextResponse } from "next/server";
import { runIngest, runRefreshTagCounts, runSummarizePending } from "@/lib/ingest/run";
import { isAuthorizedRequest } from "@/lib/utils/auth";
import { boundedInteger } from "@/lib/utils/numbers";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ingest = await runIngest({ limit: boundedInteger(process.env.INGEST_LIMIT_PER_SOURCE, 5, { min: 1, max: 100 }) });
  const summarize = await runSummarizePending({ limit: boundedInteger(process.env.CRON_SUMMARY_LIMIT, 20, { min: 1, max: 100 }) });
  const tags = await runRefreshTagCounts();

  return NextResponse.json({ ingest, summarize, tags });
}
