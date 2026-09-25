import { getSupabaseAdmin } from "@/lib/db/client";
import { failClosedAdminAnalyticsReads } from "@/lib/admin/analytics-read-repository/fail-closed-repository";
import { withAdminAnalyticsReadShadow } from "@/lib/admin/analytics-read-repository/shadow";
import { createSupabaseAdminAnalyticsReadRepository } from "@/lib/admin/analytics-read-repository/supabase-repository";
import type { AdminAnalyticsReadRepository } from "@/lib/admin/analytics-read-repository/types";

export * from "@/lib/admin/analytics-read-repository/fail-closed-repository";
export * from "@/lib/admin/analytics-read-repository/supabase-repository";
export * from "@/lib/admin/analytics-read-repository/d1-read-repository";
export * from "@/lib/admin/analytics-read-repository/shadow";
export * from "@/lib/admin/analytics-read-repository/types";

/**
 * Selection point for the privileged admin analytics/audit read domain.
 * Supabase remains authoritative whenever configuration is present; without it
 * the fail-closed adapter is used, preserving the pre-extraction no-config
 * behavior.
 *
 * When Supabase is authoritative the repository is wrapped with the M6.4
 * `admin_analytics_read` shadow. The wrapper is a pure pass-through by default
 * (all shadow flags off) and can only schedule a background bounded D1 read on
 * the `ctx.waitUntil` scheduler, never replace the authoritative result.
 * No-config behavior is unchanged: the fail-closed adapter is returned unwrapped.
 */
export function adminAnalyticsReads(): AdminAnalyticsReadRepository {
  const supabase = getSupabaseAdmin();
  if (!supabase) return failClosedAdminAnalyticsReads;
  const adminClient = supabase;
  return withAdminAnalyticsReadShadow(createSupabaseAdminAnalyticsReadRepository({ client: () => adminClient }));
}
