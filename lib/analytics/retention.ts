import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import { boundedInteger } from "@/lib/utils/numbers";

export interface SiteAnalyticsRetentionResult {
  available: boolean;
  retentionDays: number;
  deleted: number;
  error?: string;
}

export async function runSiteAnalyticsRetention(): Promise<SiteAnalyticsRetentionResult> {
  const retentionDays = boundedInteger(process.env.SITE_ANALYTICS_RETENTION_DAYS, 90, { min: 30, max: 365 });
  const binding = getRuntimeD1Binding("worldcons_ops");
  if (!binding) return { available: false, retentionDays, deleted: 0, error: "worldcons_ops D1 binding is not configured." };

  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  try {
    const statement = binding.prepare("DELETE FROM site_events WHERE occurred_at < ?").bind(cutoff);
    if (!statement.run) throw new Error("site_analytics_retention.run_unavailable");
    const result = await statement.run();
    if (result.success === false || result.error) throw new Error(result.error || "site_analytics_retention.delete_failed");
    const deleted = Number(result.meta?.changes ?? 0);
    return {
      available: true,
      retentionDays,
      deleted: Number.isFinite(deleted) ? Math.max(0, Math.trunc(deleted)) : 0,
    };
  } catch (error) {
    return {
      available: false,
      retentionDays,
      deleted: 0,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    };
  }
}
