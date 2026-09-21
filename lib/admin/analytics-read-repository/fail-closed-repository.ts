import type { AdminAnalyticsReadRepository } from "@/lib/admin/analytics-read-repository/types";

/**
 * In-memory fallback selected when Supabase configuration is absent. The admin
 * analytics/audit domain is fail-closed: with no database the audit reads
 * resolve empty, the `site_events` analytics read reports `schemaReady: false`,
 * the legacy ingestion/article reads are empty, and the health snapshot is
 * unavailable — so the exported callers keep their pre-extraction no-config
 * behavior exactly (empty audit page, empty dashboard totals, legacy health
 * fallback).
 */
export const failClosedAdminAnalyticsReads: AdminAnalyticsReadRepository = {
  isConfigured() {
    return false;
  },
  async loadAdminAuditActionOptionRows() {
    return [];
  },
  async loadAdminAuditEntryRows() {
    return { status: "ok", rows: [], count: 0 };
  },
  async loadSiteEvents() {
    return { rows: [], schemaReady: false };
  },
  async loadIngestionRunRows() {
    return [];
  },
  async loadArticleSummaryRows() {
    return [];
  },
  async loadAnalyticsHealthSnapshot() {
    return null;
  },
};
