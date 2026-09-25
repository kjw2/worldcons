import { D1_SHADOW_DEFAULT_MAX_ROWS } from "@/lib/cloudflare/d1/shadow/config";
import { runD1RuntimeRead, type D1RuntimeReadPredicate } from "@/lib/cloudflare/d1/runtime-read";
import { getRuntimeD1Binding, type D1RuntimeDatabase } from "@/lib/cloudflare/d1/runtime-binding";
import type { D1TableDefinition } from "@/lib/cloudflare/d1/types";
import { d1Schema } from "@/lib/cloudflare/d1/schema";
import { D1ShadowTruncatedError } from "@/lib/reference-reads/d1-repository";
import type {
  AdminAnalyticsArticleRow,
  AdminAnalyticsIngestionRunRow,
  AdminAnalyticsSiteEventRow,
  AdminAnalyticsSiteEventsResult,
  AdminAuditEntryRowsRequest,
  AdminAuditEntryRowsResult,
} from "@/lib/admin/analytics-read-repository/types";

/**
 * M6.4 D1-backed privileged admin analytics/audit reads.
 *
 * This is the shadow reader for the five bounded `AdminAnalyticsReadRepository`
 * methods that have a migrated D1 equivalent:
 *
 * - `loadAdminAuditActionOptionRows` -> `worldcons_ops.site_events`
 * - `loadAdminAuditEntryRows`        -> `worldcons_ops.site_events`
 * - `loadSiteEvents`                 -> `worldcons_ops.site_events`
 * - `loadIngestionRunRows`           -> `worldcons_ingest.ingestion_runs`
 * - `loadArticleSummaryRows`         -> `worldcons_core.articles`
 *
 * `loadAnalyticsHealthSnapshot` is an authoritative RPC with no migrated D1
 * equivalent; the wrapper never calls this adapter for it.
 *
 * The database binding is exact per method/table and can never be substituted.
 * Every read is read-only and bounded (`maxRows + 1`): whenever the entire
 * authoritative result cannot be proven within `maxRows` the typed
 * `D1ShadowTruncatedError` is raised so the wrapper skips rather than compare a
 * partial result. `loadSiteEvents` uses the access-info column set, which the
 * migrated `site_events` schema supports.
 *
 * The legacy `rpc_admin_analytics_health_snapshot` is not reimplemented here and
 * this adapter performs no Supabase write, no P5 observation and no D1 write.
 */
export class D1AdminAnalyticsShadowSkipError extends Error {
  readonly code = "d1_admin_analytics_shadow.skip";
  readonly reason: string;
  readonly method: string;
  constructor(reason: string, method: string) {
    super(`D1 admin analytics shadow skipped ${method}: ${reason}`);
    this.name = "D1AdminAnalyticsShadowSkipError";
    this.reason = reason;
    this.method = method;
  }
}

export interface D1AdminAnalyticsReadDependencies {
  /** The `worldcons_core` binding. Resolved from the runtime slot when omitted. */
  binding?: D1RuntimeDatabase | null;
  /** The `worldcons_ingest` binding. Resolved from the runtime slot when omitted. */
  ingestBinding?: D1RuntimeDatabase | null;
  /** The `worldcons_ops` binding. Resolved from the runtime slot when omitted. */
  opsBinding?: D1RuntimeDatabase | null;
  /** Bounded shadow read limit. */
  maxRows?: number;
}

export const ADMIN_AUDIT_COLUMNS = [
  "id",
  "occurred_at",
  "event_type",
  "path",
  "article_slug",
  "source_key",
  "metadata",
] as const;

/**
 * The analytics `site_events` access-info column set. Every column exists in the
 * migrated D1 `worldcons_ops.site_events` schema, so `schemaReady` is always true
 * when the shadow reads successfully.
 */
export const SITE_EVENT_ACCESS_INFO_COLUMNS = [
  "occurred_at",
  "event_type",
  "path",
  "article_slug",
  "article_title",
  "tag_slug",
  "tag_name",
  "source_key",
  "jurisdiction",
  "institution_name",
  "search_query",
  "search_mode",
  "result_count",
  "referrer_host",
  "user_agent_family",
  "device_type",
  "metadata",
  "client_ip_hash",
  "accept_language",
  "client_country",
  "is_bot",
] as const;

export const INGESTION_RUN_COLUMNS = [
  "source_key",
  "status",
  "discovered_count",
  "fetched_count",
  "summarized_count",
  "failed_count",
  "started_at",
] as const;

export const ARTICLE_SUMMARY_COLUMNS = [
  "status",
  "source_key",
  "summary_json",
  "error_metadata",
  "source_metadata",
  "summarized_at",
  "updated_at",
] as const;

const ADMIN_AUDIT_LIMIT = 1000;
const SITE_EVENT_LIMIT = 10_000;
const INGESTION_RUN_LIMIT = 1000;

function tableByName(schema = d1Schema): Map<string, D1TableDefinition> {
  return new Map(schema.tables.map((table) => [table.name, table]));
}

function requireCore(dependencies: D1AdminAnalyticsReadDependencies): D1RuntimeDatabase {
  const binding = dependencies.binding ?? getRuntimeD1Binding("worldcons_core");
  if (!binding) throw new Error("worldcons_core D1 binding is not available");
  return binding;
}

function requireIngest(dependencies: D1AdminAnalyticsReadDependencies): D1RuntimeDatabase {
  const binding = dependencies.ingestBinding ?? getRuntimeD1Binding("worldcons_ingest");
  if (!binding) throw new Error("worldcons_ingest D1 binding is not available");
  return binding;
}

function requireOps(dependencies: D1AdminAnalyticsReadDependencies): D1RuntimeDatabase {
  const binding = dependencies.opsBinding ?? getRuntimeD1Binding("worldcons_ops");
  if (!binding) throw new Error("worldcons_ops D1 binding is not available");
  return binding;
}

function siteEventRowShape(row: Record<string, unknown>): AdminAnalyticsSiteEventRow {
  return row as unknown as AdminAnalyticsSiteEventRow;
}

function validEventTypes(eventTypes: readonly string[]): boolean {
  return Array.isArray(eventTypes) && eventTypes.length > 0 && eventTypes.every((value) => typeof value === "string" && value.length > 0);
}

export function createD1AdminAnalyticsReadRepository(dependencies: D1AdminAnalyticsReadDependencies = {}) {
  const maxRows = dependencies.maxRows ?? D1_SHADOW_DEFAULT_MAX_ROWS;
  const tables = tableByName();

  function requireTable(name: string): D1TableDefinition {
    const table = tables.get(name);
    if (!table) throw new Error(`D1 schema has no table ${name}`);
    return table;
  }

  async function read(
    binding: D1RuntimeDatabase,
    table: string,
    request: {
      select?: readonly string[];
      where?: readonly D1RuntimeReadPredicate[];
      orderBy?: readonly { column: string; direction?: "asc" | "desc"; nulls?: "first" | "last" }[];
      limit: number;
      offset?: number;
    },
  ): Promise<Record<string, unknown>[]> {
    return runD1RuntimeRead({
      binding,
      table: requireTable(table),
      select: request.select,
      where: request.where,
      orderBy: request.orderBy,
      limit: request.limit,
      offset: request.offset,
    });
  }

  /**
   * The authoritative audit action-option read takes the most recent 1000
   * event-typed rows. The bounded scan must be able to prove that boundary: if
   * `maxRows` is below 1000, or the scan overflows, it skips rather than
   * approximate (`ambiguous_limit` / `shadow_truncated`).
   */
  async function loadAdminAuditActionOptionRows(eventTypes: string[]): Promise<AdminAnalyticsSiteEventRow[]> {
    if (!validEventTypes(eventTypes)) {
      throw new D1AdminAnalyticsShadowSkipError("invalid_event_types", "loadAdminAuditActionOptionRows");
    }
    if (maxRows < ADMIN_AUDIT_LIMIT) {
      throw new D1AdminAnalyticsShadowSkipError("limit_exceeds_max_rows", "loadAdminAuditActionOptionRows");
    }
    const rows = await read(requireOps(dependencies), "site_events", {
      select: [...ADMIN_AUDIT_COLUMNS],
      where: [{ column: "event_type", op: "in", value: eventTypes }],
      orderBy: [{ column: "occurred_at", direction: "desc" }],
      limit: ADMIN_AUDIT_LIMIT + 1,
    });
    if (rows.length > ADMIN_AUDIT_LIMIT) {
      throw new D1ShadowTruncatedError("loadAdminAuditActionOptionRows");
    }
    return rows.map(siteEventRowShape);
  }

  /**
   * The authoritative audit entry read. The filtered branch takes the latest
   * 1000 with a null count; the unfiltered branch is an exact-count range read.
   * Both must be proven within `maxRows`.
   */
  async function loadAdminAuditEntryRows(request: AdminAuditEntryRowsRequest): Promise<AdminAuditEntryRowsResult> {
    if (!validEventTypes(request.eventTypes)) {
      throw new D1AdminAnalyticsShadowSkipError("invalid_event_types", "loadAdminAuditEntryRows");
    }
    const binding = requireOps(dependencies);
    const orderBy = [{ column: "occurred_at", direction: "desc" as const }];
    const where: D1RuntimeReadPredicate[] = [{ column: "event_type", op: "in", value: request.eventTypes }];

    if (request.filtered) {
      if (maxRows < ADMIN_AUDIT_LIMIT) {
        throw new D1AdminAnalyticsShadowSkipError("limit_exceeds_max_rows", "loadAdminAuditEntryRows");
      }
      const rows = await read(binding, "site_events", {
        select: [...ADMIN_AUDIT_COLUMNS],
        where,
        orderBy,
        limit: ADMIN_AUDIT_LIMIT + 1,
      });
      if (rows.length > ADMIN_AUDIT_LIMIT) throw new D1ShadowTruncatedError("loadAdminAuditEntryRows");
      return { status: "ok", rows: rows.map(siteEventRowShape), count: null };
    }

    const from = Number.isInteger(request.from) && request.from >= 0 ? request.from : 0;
    const to = Number.isInteger(request.to) && request.to >= from ? request.to : from;
    const pageSize = to - from + 1;
    if (pageSize <= 0) throw new D1AdminAnalyticsShadowSkipError("invalid_range", "loadAdminAuditEntryRows");
    if (maxRows < to + 1) {
      throw new D1AdminAnalyticsShadowSkipError("range_exceeds_max_rows", "loadAdminAuditEntryRows");
    }
    const rows = await read(binding, "site_events", {
      select: [...ADMIN_AUDIT_COLUMNS],
      where,
      orderBy,
      limit: maxRows + 1,
    });
    if (rows.length > maxRows) throw new D1ShadowTruncatedError("loadAdminAuditEntryRows");
    return {
      status: "ok",
      rows: rows.slice(from, to + 1).map(siteEventRowShape),
      count: rows.length,
    };
  }

  /**
   * The analytics `site_events` access-info read. The migrated D1 schema has
   * every access-info column, so a successful read is always `schemaReady: true`
   * and the wrapper can compare the full `{ rows, schemaReady }` result.
   */
  async function loadSiteEvents(since: string): Promise<AdminAnalyticsSiteEventsResult> {
    if (typeof since !== "string" || since.length === 0) {
      throw new D1AdminAnalyticsShadowSkipError("invalid_since", "loadSiteEvents");
    }
    if (maxRows < SITE_EVENT_LIMIT) {
      throw new D1AdminAnalyticsShadowSkipError("limit_exceeds_max_rows", "loadSiteEvents");
    }
    const rows = await read(requireOps(dependencies), "site_events", {
      select: [...SITE_EVENT_ACCESS_INFO_COLUMNS],
      where: [{ column: "occurred_at", op: "gte", value: since }],
      orderBy: [{ column: "occurred_at", direction: "desc" }],
      limit: SITE_EVENT_LIMIT + 1,
    });
    if (rows.length > SITE_EVENT_LIMIT) throw new D1ShadowTruncatedError("loadSiteEvents");
    return { rows: rows.map(siteEventRowShape), schemaReady: true };
  }

  async function loadIngestionRunRows(since: string): Promise<AdminAnalyticsIngestionRunRow[]> {
    if (typeof since !== "string" || since.length === 0) {
      throw new D1AdminAnalyticsShadowSkipError("invalid_since", "loadIngestionRunRows");
    }
    if (maxRows < INGESTION_RUN_LIMIT) {
      throw new D1AdminAnalyticsShadowSkipError("limit_exceeds_max_rows", "loadIngestionRunRows");
    }
    const rows = await read(requireIngest(dependencies), "ingestion_runs", {
      select: [...INGESTION_RUN_COLUMNS],
      where: [{ column: "started_at", op: "gte", value: since }],
      orderBy: [{ column: "started_at", direction: "desc" }],
      limit: INGESTION_RUN_LIMIT + 1,
    });
    if (rows.length > INGESTION_RUN_LIMIT) throw new D1ShadowTruncatedError("loadIngestionRunRows");
    return rows as unknown as AdminAnalyticsIngestionRunRow[];
  }

  /**
   * The legacy article health read pages without a cap in the authoritative
   * adapter. The shadow only compares when the entire D1 set is proven within
   * `maxRows`; it never emulates the authoritative partial-row-on-error
   * semantics.
   */
  async function loadArticleSummaryRows(): Promise<AdminAnalyticsArticleRow[]> {
    const rows = await read(requireCore(dependencies), "articles", {
      select: [...ARTICLE_SUMMARY_COLUMNS],
      orderBy: [{ column: "id", direction: "asc" }],
      limit: maxRows + 1,
    });
    if (rows.length > maxRows) throw new D1ShadowTruncatedError("loadArticleSummaryRows");
    return rows as unknown as AdminAnalyticsArticleRow[];
  }

  return {
    loadAdminAuditActionOptionRows,
    loadAdminAuditEntryRows,
    loadSiteEvents,
    loadIngestionRunRows,
    loadArticleSummaryRows,
  };
}

export type D1AdminAnalyticsReadRepository = ReturnType<typeof createD1AdminAnalyticsReadRepository>;
