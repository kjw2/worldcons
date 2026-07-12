import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const GATE0_TOOL_NAME = "worldcons-admin-redesign-gate0";
export const GATE0_TOOL_VERSION = "1.0.0";
export const GATE0_OUTPUT_DIRECTORY = path.join("artifacts", "admin-redesign", "gate0");
export const GATE0_TRANSACTION_BEGIN = "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY";
export const GATE0_RELEVANT_TABLES = [
  "sources",
  "articles",
  "tags",
  "article_tags",
  "ingestion_runs",
  "source_url_candidates",
  "glossary_terms",
  "glossary_candidates",
  "admin_jobs",
  "admin_job_events",
  "admin_audit_logs",
  "admin_article_edit_history",
] as const;

export const GATE0_THRESHOLDS = {
  staleArticleMinutes: 30,
  staleCancelMinutes: 15,
  staleQueuedJobMinutes: 30,
} as const;

export const GATE0_QUERIES = {
  environment: `
    select
      current_setting('server_version') as server_version,
      current_setting('server_version_num') as server_version_num,
      current_setting('transaction_isolation') as transaction_isolation,
      current_setting('transaction_read_only') as transaction_read_only
  `,
  tableStats: `
    select
      relname as table_name,
      n_live_tup as live_rows,
      n_dead_tup as dead_rows
    from pg_stat_user_tables
    where schemaname = 'public'
      and relname = any($1::text[])
    order by relname
  `,
  stateDistributions: `
    with states as (
      select 'articles'::text as table_name, 'status'::text as column_name, status::text as state from public.articles
      union all
      select 'articles', 'review_state', coalesce(review_state::text, '<null>') from public.articles
      union all
      select 'ingestion_runs', 'status', status::text from public.ingestion_runs
      union all
      select 'source_url_candidates', 'status', status::text from public.source_url_candidates
      union all
      select 'glossary_candidates', 'status', status::text from public.glossary_candidates
      union all
      select 'admin_jobs', 'status', status::text from public.admin_jobs
    )
    select table_name, column_name, state, count(*) as row_count
    from states
    group by table_name, column_name, state
    order by table_name, column_name, state
  `,
  publicationCounts: `
    select
      count(*) filter (
        where status = 'summarized'
          and source_metadata #>> '{collection,publishable}' = 'true'
      ) as explicit_public_count,
      count(*) filter (
        where status = 'summarized'
          and source_metadata #>> '{collection,publishable}' is null
      ) as legacy_public_count,
      count(*) filter (
        where source_metadata #>> '{collection,publishable}' = 'true'
          and status <> 'summarized'
      ) as marker_true_non_summarized_count,
      count(*) filter (
        where source_metadata #>> '{collection,publishable}' = 'true'
          and coalesce(jsonb_typeof(summary_json), 'null') <> 'object'
      ) as public_missing_summary_count,
      count(*) filter (
        where source_metadata #>> '{collection,publishable}' is not null
          and source_metadata #>> '{collection,publishable}' not in ('true', 'false')
      ) as malformed_marker_count,
      count(*) filter (
        where (source_metadata #>> '{collection,publishable}' = 'true' and status <> 'summarized')
          or (
            source_metadata #>> '{collection,publishable}' = 'true'
            and coalesce(jsonb_typeof(summary_json), 'null') <> 'object'
          )
          or (
            source_metadata #>> '{collection,publishable}' is not null
            and source_metadata #>> '{collection,publishable}' not in ('true', 'false')
          )
      ) as malformed_public_total_count,
      count(*) filter (
        where status = 'summarizing'
          and updated_at < current_timestamp - ($1::integer * interval '1 minute')
      ) as stale_summarizing_count
    from public.articles
  `,
  jobHealth: `
    select
      count(*) filter (
        where status = 'queued'
          and requested_at < current_timestamp - ($1::integer * interval '1 minute')
      ) as stale_queued_count,
      count(*) filter (
        where status = 'running'
          and (lease_until is null or lease_until < current_timestamp)
      ) as stale_running_count,
      count(*) filter (
        where status = 'cancel_requested'
          or (cancel_requested_at is not null and status not in ('cancelled', 'succeeded', 'failed'))
      ) as cancel_backlog_count,
      count(*) filter (
        where (
          status = 'cancel_requested'
          or (cancel_requested_at is not null and status not in ('cancelled', 'succeeded', 'failed'))
        )
        and coalesce(cancel_requested_at, updated_at)
          < current_timestamp - ($2::integer * interval '1 minute')
      ) as stale_cancel_count,
      count(*) filter (
        where status = 'cancelled' and cancelled_at is null
      ) as cancelled_missing_timestamp_count,
      count(*) filter (
        where status in ('succeeded', 'failed', 'cancelled') and finished_at is null
      ) as terminal_missing_finished_count
    from public.admin_jobs
  `,
  indexes: `
    select
      stats.schemaname as schema_name,
      stats.relname as table_name,
      stats.indexrelname as index_name,
      pg_relation_size(stats.indexrelid) as size_bytes,
      indexes.indexdef as definition
    from pg_stat_user_indexes stats
    join pg_indexes indexes
      on indexes.schemaname = stats.schemaname
      and indexes.tablename = stats.relname
      and indexes.indexname = stats.indexrelname
    where stats.schemaname = 'public'
      and stats.relname = any($1::text[])
    order by stats.relname, stats.indexrelname
  `,
  constraints: `
    select
      namespace.nspname as schema_name,
      relation.relname as table_name,
      constraint_record.conname as constraint_name,
      constraint_record.contype as constraint_type,
      constraint_record.convalidated as validated,
      pg_get_constraintdef(constraint_record.oid, true) as definition
    from pg_constraint constraint_record
    join pg_class relation on relation.oid = constraint_record.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = any($1::text[])
    order by relation.relname, constraint_record.conname
  `,
} as const;

export type Gate0Mode = "dry" | "live";

export interface Gate0Report {
  tool: {
    name: string;
    version: string;
    commitSha: string;
    capturedAt: string;
    environment: string;
    mode: Gate0Mode;
  };
  transaction: {
    requestedIsolation: "repeatable read";
    requestedReadOnly: true;
    observedIsolation: string | null;
    observedReadOnly: boolean | null;
    verified: boolean;
  };
  postgres: {
    version: string | null;
    versionNumber: number | null;
  };
  contract: {
    queryIds: string[];
    relevantTables: string[];
    thresholds: typeof GATE0_THRESHOLDS;
  };
  tableStats: Array<{ table: string; liveRows: number; deadRows: number }>;
  stateDistributions: Array<{ table: string; column: string; state: string; count: number }>;
  publicationCounts: {
    explicitPublic: number;
    legacyPublic: number;
    markerTrueNonSummarized: number;
    publicMissingSummary: number;
    malformedMarker: number;
    malformedPublicTotal: number;
    staleSummarizing: number;
  };
  jobHealth: {
    staleQueued: number;
    staleRunning: number;
    cancelBacklog: number;
    staleCancel: number;
    cancelledMissingTimestamp: number;
    terminalMissingFinished: number;
  };
  indexes: Array<{
    schema: string;
    table: string;
    name: string;
    sizeBytes: number;
    definition: string;
  }>;
  constraints: Array<{
    schema: string;
    table: string;
    name: string;
    type: string;
    validated: boolean;
    definition: string;
  }>;
  anomalyCounts: {
    legacyPublic: number;
    malformedPublic: number;
    staleArticles: number;
    staleJobs: number;
    cancelBacklog: number;
  };
}

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:^|_)(?:url|uri|password|passwd|secret|token|credential|api_key|apikey|metadata|raw|payload|source_text|error_message|connection_string)(?:$|_)/i;
const SENSITIVE_VALUE_PATTERNS = [
  /\b(?:https?|postgres|postgresql):\/\/[^\s]+/i,
  /\b(?:password|passwd|secret|token|credential|api[_-]?key)\s*[:=]\s*[^\s,;]+/i,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

function redactString(value: string) {
  if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) return REDACTED;
  return value;
}

export function redactGate0Value(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactGate0Value(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactGate0Value(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
  }
  return value;
}

function compareAscii(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function stableJson(value: unknown) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function createEmptyGate0Report(input: {
  commitSha: string;
  capturedAt: string;
  environment: string;
  mode: Gate0Mode;
}): Gate0Report {
  return {
    tool: {
      name: GATE0_TOOL_NAME,
      version: GATE0_TOOL_VERSION,
      commitSha: input.commitSha,
      capturedAt: input.capturedAt,
      environment: input.environment,
      mode: input.mode,
    },
    transaction: {
      requestedIsolation: "repeatable read",
      requestedReadOnly: true,
      observedIsolation: null,
      observedReadOnly: null,
      verified: false,
    },
    postgres: { version: null, versionNumber: null },
    contract: {
      queryIds: Object.keys(GATE0_QUERIES).sort(),
      relevantTables: [...GATE0_RELEVANT_TABLES].sort(),
      thresholds: GATE0_THRESHOLDS,
    },
    tableStats: [],
    stateDistributions: [],
    publicationCounts: {
      explicitPublic: 0,
      legacyPublic: 0,
      markerTrueNonSummarized: 0,
      publicMissingSummary: 0,
      malformedMarker: 0,
      malformedPublicTotal: 0,
      staleSummarizing: 0,
    },
    jobHealth: {
      staleQueued: 0,
      staleRunning: 0,
      cancelBacklog: 0,
      staleCancel: 0,
      cancelledMissingTimestamp: 0,
      terminalMissingFinished: 0,
    },
    indexes: [],
    constraints: [],
    anomalyCounts: {
      legacyPublic: 0,
      malformedPublic: 0,
      staleArticles: 0,
      staleJobs: 0,
      cancelBacklog: 0,
    },
  };
}

function renderRows<T>(rows: T[], render: (row: T) => string) {
  return rows.length ? rows.map(render) : ["(none)"];
}

export function renderGate0Text(report: Gate0Report) {
  const lines = [
    "Worldcons administrator redesign Gate 0 baseline",
    `tool: ${report.tool.name} ${report.tool.version}`,
    `commit: ${report.tool.commitSha}`,
    `captured_at: ${report.tool.capturedAt}`,
    `environment: ${report.tool.environment}`,
    `mode: ${report.tool.mode}`,
    `transaction: isolation=${report.transaction.observedIsolation ?? "not-executed"} read_only=${report.transaction.observedReadOnly ?? "not-executed"} verified=${report.transaction.verified}`,
    `postgres: version=${report.postgres.version ?? "not-executed"} version_number=${report.postgres.versionNumber ?? "not-executed"}`,
    "",
    "Anomaly counts",
    `legacy_public: ${report.anomalyCounts.legacyPublic}`,
    `malformed_public: ${report.anomalyCounts.malformedPublic}`,
    `stale_articles: ${report.anomalyCounts.staleArticles}`,
    `stale_jobs: ${report.anomalyCounts.staleJobs}`,
    `cancel_backlog: ${report.anomalyCounts.cancelBacklog}`,
    "",
    "Publication counts",
    ...Object.entries(report.publicationCounts).sort(([left], [right]) => compareAscii(left, right)).map(([key, value]) => `${key}: ${value}`),
    "",
    "Job health",
    ...Object.entries(report.jobHealth).sort(([left], [right]) => compareAscii(left, right)).map(([key, value]) => `${key}: ${value}`),
    "",
    "Table estimates",
    ...renderRows(report.tableStats, (row) => `${row.table}: live=${row.liveRows} dead=${row.deadRows}`),
    "",
    "State distributions",
    ...renderRows(report.stateDistributions, (row) => `${row.table}.${row.column}.${row.state}: ${row.count}`),
    "",
    "Indexes",
    ...renderRows(report.indexes, (row) => `${row.schema}.${row.table}.${row.name}: size_bytes=${row.sizeBytes} definition=${JSON.stringify(row.definition)}`),
    "",
    "Constraints",
    ...renderRows(
      report.constraints,
      (row) => `${row.schema}.${row.table}.${row.name}: type=${row.type} validated=${row.validated} definition=${JSON.stringify(row.definition)}`,
    ),
    "",
    "Query contract",
    ...report.contract.queryIds.map((queryId) => `query: ${queryId}`),
    ...report.contract.relevantTables.map((table) => `table: ${table}`),
    `threshold.stale_article_minutes: ${report.contract.thresholds.staleArticleMinutes}`,
    `threshold.stale_cancel_minutes: ${report.contract.thresholds.staleCancelMinutes}`,
    `threshold.stale_queued_job_minutes: ${report.contract.thresholds.staleQueuedJobMinutes}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function writeGate0Artifacts(outputDirectory: string, report: Gate0Report) {
  const redactedReport = redactGate0Value(report) as Gate0Report;
  const json = stableJson(redactedReport);
  const text = renderGate0Text(redactedReport);
  const files = [
    { name: "gate0-report.json", content: json },
    { name: "gate0-report.txt", content: text },
  ].sort((left, right) => compareAscii(left.name, right.name));
  const hashes = Object.fromEntries(files.map((file) => [file.name, sha256(file.content)]));
  const manifest = `${files.map((file) => `${hashes[file.name]}  ${file.name}`).join("\n")}\n`;

  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(outputDirectory, file.name), file.content, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(path.join(outputDirectory, "manifest.sha256"), manifest, { encoding: "utf8", mode: 0o600 });

  return { directory: outputDirectory, hashes, manifest };
}
