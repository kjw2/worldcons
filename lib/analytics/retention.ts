import { getSupabaseAdmin } from "@/lib/db/client";
import { boundedInteger } from "@/lib/utils/numbers";

export interface SiteAnalyticsRetentionResult {
  available: boolean;
  retentionDays: number;
  deleted: number;
  error?: string;
}

export async function runSiteAnalyticsRetention(): Promise<SiteAnalyticsRetentionResult> {
  const retentionDays = boundedInteger(process.env.SITE_ANALYTICS_RETENTION_DAYS, 90, { min: 30, max: 365 });
  const supabase = getSupabaseAdmin();
  if (!supabase) return { available: false, retentionDays, deleted: 0 };

  const { data, error } = await supabase.rpc("purge_site_events", {
    retention_days: retentionDays,
  });

  if (error) {
    return {
      available: false,
      retentionDays,
      deleted: 0,
      error: error.message.slice(0, 300),
    };
  }

  const deleted = typeof data === "number" ? data : Number(data);
  return {
    available: true,
    retentionDays,
    deleted: Number.isFinite(deleted) ? Math.max(0, Math.trunc(deleted)) : 0,
  };
}
