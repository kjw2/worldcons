import { NextResponse } from "next/server";
import { adminIngestResultSucceeded } from "@/lib/admin/admin-ingest-jobs";
import { runSiteAnalyticsRetention } from "@/lib/analytics/retention";
import { executeAdminCompatibilityCommand } from "@/lib/admin/command-control-plane/compatibility";
import { runRefreshTagCounts, runSummarizePending } from "@/lib/ingest/summary";
import { summaryBatchHasHardFailure, summaryBatchWasDeferred } from "@/lib/ingest/summary-batch";
import { invalidatePublicContentCaches } from "@/lib/public-content-cache";
import { CollectionPausedError, assertCollectionCanStart } from "@/lib/masterdash/store";
import { isAuthorizedSecretRequest } from "@/lib/utils/auth";
import { boundedInteger } from "@/lib/utils/numbers";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cronIngestSucceeded(value: { ingest: unknown; summarize: unknown; tags: unknown }) {
  return (
    adminIngestResultSucceeded(value.ingest) &&
    !summaryBatchWasDeferred(value.summarize) &&
    !summaryBatchHasHardFailure(value.summarize) &&
    isRecord(value.tags) &&
    value.tags.refreshed === true
  );
}

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
    async () => {
      const { runIngest } = await import("@/lib/ingest/run");
      const ingest = await runIngest({ limit: ingestLimit, rangeDays, refreshExisting: true });
      const summarize = await runSummarizePending({ limit: summaryLimit });
      const tags = await runRefreshTagCounts();
      const analyticsRetention = await runSiteAnalyticsRetention();
      invalidatePublicContentCaches();
      return { ingest, summarize, tags, analyticsRetention };
    },
    { isLegacySuccess: cronIngestSucceeded },
  );
  const { ingest, summarize, tags, analyticsRetention } = compatibility.value;
  const incomplete = summaryBatchWasDeferred(summarize) || summaryBatchHasHardFailure(summarize);

  return NextResponse.json({ complete: !incomplete, ingest, summarize, tags, analyticsRetention }, { status: incomplete ? 503 : 200 });
}
