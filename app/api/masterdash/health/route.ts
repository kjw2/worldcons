import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/db/client";
import { getCollectionControlState } from "@/lib/masterdash/store";
import { collectionHealthMetrics } from "@/lib/masterdash/health";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HEALTH_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function degradedHealth(message: string) {
  return NextResponse.json(
    {
      schemaVersion: 1,
      systemId: "worldcons",
      status: "degraded",
      message,
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || "0.1.0",
      metrics: {
        lastCollectionAt: null,
        lastSuccessfulCollectionAt: null,
        freshnessSeconds: null,
        checkpoint: null,
        lastRunStatus: null,
        recordsCollected: null,
        recordsAdded: null,
        pendingItems: null,
        errorCount: null,
        failureReason: null,
        failureTarget: null,
        runId: null,
        durationMs: null,
        collectionPaused: false,
        controlUpdatedAt: null,
      },
    },
    { status: 200, headers: HEALTH_HEADERS },
  );
}

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return degradedHealth("Collector database is not configured.");

    const [latest, successful, pending, failed, control] = await Promise.all([
      supabase.from("ingestion_runs").select("id, source_key, status, started_at, finished_at, fetched_count, failed_count, error_message, metadata").order("started_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("ingestion_runs").select("source_key, finished_at, metadata").eq("status", "completed").order("finished_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
      supabase.from("admin_jobs").select("id", { count: "exact", head: true }).in("status", ["queued", "running", "cancel_requested"]),
      supabase.from("admin_jobs").select("id", { count: "exact", head: true }).eq("status", "failed"),
      getCollectionControlState(),
    ]);
    const queryFailed = Boolean(latest.error || successful.error || pending.error || failed.error);
    const controlRequired = Boolean(process.env.MASTERDASH_CONTROL_SECRET?.trim());
    const degraded = queryFailed || (controlRequired && !control.available);
    const paused = control.available && control.paused;
    const metrics = collectionHealthMetrics({
      latest: latest.data,
      successful: successful.data,
      pendingItems: pending.count ?? null,
      failedJobCount: failed.count ?? null,
    });
    const lastSuccessAt = metrics.lastSuccessfulCollectionAt;
    const lastSuccessMs = lastSuccessAt ? Date.parse(lastSuccessAt) : Number.NaN;
    const freshnessSeconds = Number.isFinite(lastSuccessMs)
      ? Math.max(0, Math.floor((Date.now() - lastSuccessMs) / 1000))
      : null;

    return NextResponse.json(
      {
        schemaVersion: 1,
        systemId: "worldcons",
        status: degraded ? "degraded" : "healthy",
        message: degraded
          ? "Collector metrics or control state are unavailable."
          : paused
            ? "Collector is ready; new collection starts are paused."
            : "Collector is ready.",
        version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || "0.1.0",
        metrics: {
          ...metrics,
          freshnessSeconds,
          collectionPaused: paused,
          controlUpdatedAt: control.updatedAt,
        },
      },
      { status: 200, headers: HEALTH_HEADERS },
    );
  } catch {
    return degradedHealth("Collector metrics are temporarily unavailable.");
  }
}
