import { NextResponse } from "next/server";
import {
  runScheduledIngestForRuntime,
  runtimeScheduledIngestSucceeded,
} from "@/lib/admin/admin-worker-execution";
import { executeAdminCompatibilityCommand } from "@/lib/admin/command-control-plane/compatibility";
import { summaryBatchHasHardFailure, summaryBatchWasDeferred } from "@/lib/ingest/summary-batch";
import { CollectionPausedError, assertCollectionCanStart } from "@/lib/masterdash/store";
import { isAuthorizedSecretRequest } from "@/lib/utils/auth";
import { boundedInteger } from "@/lib/utils/numbers";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  if (!isAuthorizedSecretRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await assertCollectionCanStart();
  } catch (error) {
    const paused = error instanceof CollectionPausedError;
    return NextResponse.json(
      {
        complete: false,
        error: paused ? error.message : "Collection control state is unavailable; scheduled collection was not started.",
      },
      { status: paused ? error.status : 503 },
    );
  }

  const ingestLimit = boundedInteger(process.env.INGEST_LIMIT_PER_SOURCE, 5, { min: 1, max: 100 });
  const rangeDays = boundedInteger(process.env.INGEST_RANGE_DAYS, 14, { min: 1, max: 365 });
  const summaryLimit = boundedInteger(process.env.CRON_SUMMARY_LIMIT, 20, { min: 1, max: 100 });
  const compatibility = await executeAdminCompatibilityCommand(
    {
      commandType: "cron.ingest",
      payloadRef: { ingestLimit, rangeDays, summaryLimit },
      request,
      requestedBy: "cron",
    },
    () => runScheduledIngestForRuntime({ ingestLimit, rangeDays, summaryLimit }),
    { isLegacySuccess: runtimeScheduledIngestSucceeded },
  );
  const result = compatibility.value;
  if (result.mode === "external_worker_required") return NextResponse.json(result, { status: 503 });
  const { ingest, summarize, tags, analyticsRetention } = result;
  const incomplete = summaryBatchWasDeferred(summarize) || summaryBatchHasHardFailure(summarize);

  return NextResponse.json({ complete: !incomplete, ingest, summarize, tags, analyticsRetention }, { status: incomplete ? 503 : 200 });
}
