import { getSupabaseAdmin } from "@/lib/db/client";
import { failClosedAdminAnalyticsReads } from "@/lib/admin/analytics-read-repository/fail-closed-repository";
import { createSupabaseAdminAnalyticsReadRepository } from "@/lib/admin/analytics-read-repository/supabase-repository";
import type { AdminAnalyticsReadRepository } from "@/lib/admin/analytics-read-repository/types";

export * from "@/lib/admin/analytics-read-repository/fail-closed-repository";
export * from "@/lib/admin/analytics-read-repository/supabase-repository";
export * from "@/lib/admin/analytics-read-repository/types";

/**
 * Selection point for the privileged admin analytics/audit read domain.
 * Supabase remains authoritative whenever configuration is present; without it
 * the fail-closed adapter is used, preserving the pre-extraction no-config
 * behavior.
 */
export function adminAnalyticsReads(): AdminAnalyticsReadRepository {
  const supabase = getSupabaseAdmin();
  if (!supabase) return failClosedAdminAnalyticsReads;
  const adminClient = supabase;
  return createSupabaseAdminAnalyticsReadRepository({ client: () => adminClient });
}
