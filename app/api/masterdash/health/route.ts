import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/db/client";
import { getCollectionControlState } from "@/lib/masterdash/store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function text(value: unknown) {
  return typeof value === "string" ? value : null;
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function GET() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json(
      {
        status: "degraded",
        message: "Collector database is not configured.",
        version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || "0.1.0",
        metrics: {
          lastCollectionAt: null,
          lastSuccessfulCollectionAt: null,
          checkpoint: null,
          recordsCollected: 0,
          pendingItems: 0,
          errorCount: 0,
        },
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  const [latest, successful, pending, failed, control] = await Promise.all([
    supabase.from("ingestion_runs").select("source_key, started_at, finished_at, fetched_count, failed_count").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("ingestion_runs").select("source_key, finished_at, fetched_count").eq("status", "completed").order("finished_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
    supabase.from("admin_jobs").select("id", { count: "exact", head: true }).in("status", ["queued", "running", "cancel_requested"]),
    supabase.from("admin_jobs").select("id", { count: "exact", head: true }).eq("status", "failed"),
    getCollectionControlState(),
  ]);
  const queryFailed = Boolean(latest.error || successful.error || pending.error || failed.error);
  const controlRequired = Boolean(process.env.MASTERDASH_CONTROL_SECRET?.trim());
  const degraded = queryFailed || (controlRequired && !control.available);
  const paused = control.available && control.paused;
  const lastSuccessAt = text(successful.data?.finished_at);
  const checkpointSource = text(successful.data?.source_key);

  return NextResponse.json(
    {
      status: degraded ? "degraded" : "healthy",
      message: degraded
        ? "Collector metrics or control state are unavailable."
        : paused
          ? "Collector is ready; new collection starts are paused."
          : "Collector is ready.",
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || "0.1.0",
      metrics: {
        lastCollectionAt: text(latest.data?.started_at),
        lastSuccessfulCollectionAt: lastSuccessAt,
        checkpoint: checkpointSource && lastSuccessAt ? `${checkpointSource}:${lastSuccessAt}` : null,
        recordsCollected: count(successful.data?.fetched_count),
        pendingItems: pending.count ?? 0,
        errorCount: (failed.count ?? 0) + count(latest.data?.failed_count),
        collectionPaused: paused,
      },
    },
    { status: 200, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}
