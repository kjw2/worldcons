import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import { createD1AdminAnalyticsReadRepository } from "@/lib/admin/analytics-read-repository/d1-read-repository";
import { failClosedAdminAnalyticsReads } from "@/lib/admin/analytics-read-repository/fail-closed-repository";
import type { AdminAnalyticsReadRepository } from "@/lib/admin/analytics-read-repository/types";

export * from "@/lib/admin/analytics-read-repository/fail-closed-repository";
export * from "@/lib/admin/analytics-read-repository/d1-read-repository";
export * from "@/lib/admin/analytics-read-repository/types";

/**
 * Cloudflare D1 is the only persistent privileged analytics/audit authority.
 */
export function adminAnalyticsReads(): AdminAnalyticsReadRepository {
  const core = getRuntimeD1Binding("worldcons_core");
  const ingest = getRuntimeD1Binding("worldcons_ingest");
  const ops = getRuntimeD1Binding("worldcons_ops");
  if (core && ingest && ops) {
    const d1 = createD1AdminAnalyticsReadRepository({
      binding: core,
      ingestBinding: ingest,
      opsBinding: ops,
    });
    return {
      ...failClosedAdminAnalyticsReads,
      ...d1,
      isConfigured: () => true,
    };
  }
  return failClosedAdminAnalyticsReads;
}
