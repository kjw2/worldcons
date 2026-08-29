import { getSupabaseAdmin } from "@/lib/db/client";
import { countOpenSourceUrlCandidates } from "@/lib/db/source-url-candidates";
import { getCollectionControlState } from "@/lib/masterdash/store";
import { resolveP5OperationalPolicy } from "@/lib/admin/p5/policy";
import { getP5HealthEvidence } from "@/lib/admin/p5/repository";
import { evaluateP5Slas } from "@/lib/admin/p5/evaluator";
import { INCREMENTAL_SOURCE_KEYS } from "@/lib/ingest/incremental";

export const OPS_EVENT_RETENTION_DAYS = 30;
const MISSED_WINDOW_HOURS = 26;
const CANDIDATE_BACKLOG_WARNING_DAYS = 7;
const LOOKBACK_HOURS = 48;
const P5_OBSERVATION_HOURS = 24;
const P5_SLA_KEYS = [
  "queue.latency",
  "queue.heartbeat",
  "queue.abort",
  "queue.retry",
  "lifecycle.backlog",
  "lifecycle.review",
  "publication.parity",
  "outbox.delivery",
  "outbox.dead_letter",
] as const;

export type WatchdogSeverity = "info" | "warning" | "critical";

export type AdminOpsEventType =
  | "watchdog_ok"
  | "watchdog_violation"
  | "watchdog_compensation"
  | "watchdog_issue_filed"
  | "watchdog_issue_updated"
  | "watchdog_issue_closed"
  | "watchdog_error";

export interface AdminOpsEvent {
  id: string;
  event_type: AdminOpsEventType;
  severity: WatchdogSeverity;
  source_key: string | null;
  summary: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface WatchdogViolation {
  key: string;
  severity: "warning" | "critical";
  sourceKey?: string;
  summary: string;
}

export interface WatchdogSourceStatus {
  sourceKey: string;
  lastRunStatus: string | null;
  lastRunOutcome: string | null;
  lastRunStartedAt: string | null;
  lastCompletedStartedAt: string | null;
  freshnessSeconds: number | null;
  addedCount: number | null;
  refreshedCount: number | null;
  uncollectedCount: number | null;
  healthy: boolean;
}

export interface WatchdogEvaluation {
  ok: boolean;
  generatedAt: string;
  paused: boolean;
  controlAvailable: boolean;
  violations: WatchdogViolation[];
  sources: WatchdogSourceStatus[];
  lastCompletedRunAt: string | null;
  pendingCandidateCount: number;
  oldestOpenCandidateAt: string | null;
  freshnessWarningSeconds: number;
  freshnessCriticalSeconds: number;
}

interface IngestionRunRow {
  source_key: string;
  status: string | null;
  started_at: string | null;
  finished_at: string | null;
  discovered_count: number | null;
  fetched_count: number | null;
  metadata: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function hoursLabel(hours: number | null) {
  return hours === null ? "-" : `${hours.toFixed(1)}h`;
}

export function evaluationViolationSignature(evaluation: WatchdogEvaluation) {
  if (evaluation.violations.length === 0) return "ok";
  return evaluation.violations.map((violation) => violation.key).sort().join("|");
}

export async function evaluateWatchdog(now = new Date()): Promise<WatchdogEvaluation> {
  const supabase = getSupabaseAdmin();
  const generatedAt = now.toISOString();
  const policy = resolveP5OperationalPolicy();
  const freshnessWarningSeconds = policy.sourceFreshnessSeconds.warning;
  const freshnessCriticalSeconds = policy.sourceFreshnessSeconds.critical;

  const violations: WatchdogViolation[] = [];
  const control = await getCollectionControlState();
  const paused = control.available && control.paused;

  if (!supabase) {
    return {
      ok: false,
      generatedAt,
      paused: false,
      controlAvailable: false,
      violations: [{ key: "watchdog-unavailable", severity: "critical", summary: "Supabase가 구성되지 않아 수집 운영 상태를 평가할 수 없습니다." }],
      sources: [],
      lastCompletedRunAt: null,
      pendingCandidateCount: 0,
      oldestOpenCandidateAt: null,
      freshnessWarningSeconds,
      freshnessCriticalSeconds,
    };
  }

  const lookbackStart = new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000).toISOString();
  const { data: runRows, error: runError } = await supabase
    .from("ingestion_runs")
    .select("source_key, status, started_at, finished_at, discovered_count, fetched_count, metadata")
    .gte("started_at", lookbackStart)
    .order("started_at", { ascending: false });

  if (runError) {
    return {
      ok: false,
      generatedAt,
      paused,
      controlAvailable: control.available,
      violations: [{ key: "watchdog-database", severity: "critical", summary: `수집 실행 기록 조회 실패: ${runError.message}` }],
      sources: [],
      lastCompletedRunAt: null,
      pendingCandidateCount: 0,
      oldestOpenCandidateAt: null,
      freshnessWarningSeconds,
      freshnessCriticalSeconds,
    };
  }

  const rowsBySource = new Map<string, IngestionRunRow[]>();
  for (const row of (runRows ?? []) as IngestionRunRow[]) {
    const key = row.source_key ?? "unknown";
    const bucket = rowsBySource.get(key);
    if (bucket) bucket.push(row);
    else rowsBySource.set(key, [row]);
  }

  const sources: WatchdogSourceStatus[] = [];
  let lastCompletedRunAt: string | null = null;

  for (const sourceKey of INCREMENTAL_SOURCE_KEYS) {
    const rows = rowsBySource.get(sourceKey) ?? [];
    const lastRun = rows[0] ?? null;
    const lastCompleted = rows.find((row) => row.status === "completed") ?? null;
    const lastRunMetadata = record(lastRun?.metadata);
    const lastCompletedMetadata = record(lastCompleted?.metadata);
    const lastRunStatus = textValue(lastRun?.status);
    const lastRunOutcome = textValue(lastRunMetadata?.outcome);
    const lastRunStartedAt = lastRun?.started_at ?? null;
    const lastCompletedStartedAt = lastCompleted?.started_at ?? null;
    const nowMs = now.getTime();
    const freshnessSeconds = lastCompletedStartedAt
      ? Math.max(0, Math.floor((nowMs - parseTimestamp(lastCompletedStartedAt)!) / 1000))
      : null;
    const freshnessHours = freshnessSeconds === null ? null : freshnessSeconds / 3600;

    if (lastCompletedStartedAt) {
      const timestamp = parseTimestamp(lastCompletedStartedAt);
      if (timestamp !== null && timestamp > parseTimestamp(lastCompletedRunAt)!) {
        lastCompletedRunAt = lastCompletedStartedAt;
      }
    }

    const sourceViolations: WatchdogViolation[] = [];

    if (lastRunStatus === "failed") {
      sourceViolations.push({ key: `source-outcome:${sourceKey}`, severity: "critical", sourceKey, summary: "마지막 수집 실행이 실패(failed)했습니다." });
    } else if (lastRunStatus === "completed" && lastRunOutcome === "failed") {
      sourceViolations.push({ key: `source-outcome:${sourceKey}`, severity: "critical", sourceKey, summary: "마지막 수집 실행 결과가 실패(failed)입니다." });
    } else if (lastRunOutcome === "degraded") {
      sourceViolations.push({ key: `source-outcome:${sourceKey}`, severity: "warning", sourceKey, summary: "마지막 수집 실행이 일부 실패(degraded)했습니다. 미수집 항목이 있습니다." });
    }

    if (lastRunStatus === null) {
      sourceViolations.push({ key: `source-silent:${sourceKey}`, severity: "critical", sourceKey, summary: `${LOOKBACK_HOURS}시간 내 수집 실행 기록이 없습니다.` });
    } else if (lastRunStatus !== "running") {
      if (freshnessHours !== null && freshnessHours * 3600 > freshnessCriticalSeconds) {
        sourceViolations.push({
          key: `source-freshness:${sourceKey}`,
          severity: "critical",
          sourceKey,
          summary: `마지막 완료 실행이 ${hoursLabel(freshnessHours)} 전입니다 (치명 임계 ${Math.round(freshnessCriticalSeconds / 3600)}h).`,
        });
      } else if (freshnessHours !== null && freshnessHours * 3600 > freshnessWarningSeconds) {
        sourceViolations.push({
          key: `source-freshness:${sourceKey}`,
          severity: "warning",
          sourceKey,
          summary: `마지막 완료 실행이 ${hoursLabel(freshnessHours)} 전입니다 (경고 임계 ${Math.round(freshnessWarningSeconds / 3600)}h).`,
        });
      }
    }

    sources.push({
      sourceKey,
      lastRunStatus,
      lastRunOutcome,
      lastRunStartedAt,
      lastCompletedStartedAt,
      freshnessSeconds,
      addedCount: numberValue(lastCompletedMetadata?.recordsAdded),
      refreshedCount: numberValue(lastCompletedMetadata?.refreshedCount),
      uncollectedCount: numberValue(lastCompletedMetadata?.uncollectedCandidateCount),
      healthy: sourceViolations.length === 0,
    });
    violations.push(...sourceViolations);
  }

  const evidence = await getP5HealthEvidence({
    observationStart: new Date(now.getTime() - P5_OBSERVATION_HOURS * 3_600_000).toISOString(),
    observationEnd: generatedAt,
    now,
    policy,
  });
  if (!evidence.available) {
    violations.push({
      key: "p5-evidence-unavailable",
      severity: "warning",
      summary: "P5 운영 지표(명령 큐/수명주기/아웃박스)를 조회할 수 없어 해당 SLA 평가를 생략했습니다.",
    });
  } else {
    for (const sla of evaluateP5Slas(evidence, policy)) {
      if (!P5_SLA_KEYS.includes(sla.key)) continue;
      if (sla.status === "critical" && sla.value !== null) {
        violations.push({
          key: `p5:${sla.key}`,
          severity: "critical",
          summary: `${sla.label}: ${sla.value}${sla.unit === "seconds" ? "초" : sla.unit} (치명 임계 ${sla.criticalThreshold}${sla.unit === "seconds" ? "초" : sla.unit}).`,
        });
      } else if (sla.status === "unknown") {
        violations.push({
          key: `p5:${sla.key}`,
          severity: "warning",
          summary: `${sla.label}을(를) 평가할 수 없습니다.`,
        });
      }
    }
  }

  let pendingCandidateCount = 0;
  let oldestOpenCandidateAt: string | null = null;
  try {
    pendingCandidateCount = await countOpenSourceUrlCandidates();
    const { data: oldest, error: oldestError } = await supabase
      .from("source_url_candidates")
      .select("created_at")
      .in("status", ["pending", "retrying"])
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!oldestError && oldest?.created_at) oldestOpenCandidateAt = oldest.created_at as string;
  } catch {
    // Candidate queue metrics are best-effort; do not fail the evaluation.
  }

  if (oldestOpenCandidateAt && pendingCandidateCount > 0) {
    const oldestHours = oldestOpenCandidateAt
      ? Math.max(0, (now.getTime() - (parseTimestamp(oldestOpenCandidateAt) ?? now.getTime())) / 3_600_000)
      : null;
    if (oldestHours !== null && oldestHours > CANDIDATE_BACKLOG_WARNING_DAYS * 24) {
      violations.push({
        key: "candidate-backlog",
        severity: "warning",
        summary: `미수집 URL 후보 ${pendingCandidateCount}건, 최고령 ${hoursLabel(oldestHours)} 전부터 대기 중입니다.`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    generatedAt,
    paused,
    controlAvailable: control.available,
    violations,
    sources,
    lastCompletedRunAt,
    pendingCandidateCount,
    oldestOpenCandidateAt,
    freshnessWarningSeconds,
    freshnessCriticalSeconds,
  };
}

export async function listAdminOpsEvents(limit = 20): Promise<AdminOpsEvent[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("admin_ops_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []).map((row) => ({
    id: String(row.id),
    event_type: row.event_type as AdminOpsEventType,
    severity: row.severity as WatchdogSeverity,
    source_key: row.source_key as string | null,
    summary: String(row.summary),
    detail: record(row.detail) ?? {},
    created_at: String(row.created_at),
  }));
}

async function pruneAdminOpsEvents(now: Date) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const cutoff = new Date(now.getTime() - OPS_EVENT_RETENTION_DAYS * 86_400_000).toISOString();
  await supabase.from("admin_ops_events").delete().lt("created_at", cutoff);
}

export async function recordAdminOpsEvent(input: {
  eventType: AdminOpsEventType;
  severity: WatchdogSeverity;
  sourceKey?: string | null;
  summary: string;
  detail?: Record<string, unknown>;
}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  await supabase.from("admin_ops_events").insert({
    event_type: input.eventType,
    severity: input.severity,
    source_key: input.sourceKey ?? null,
    summary: input.summary,
    detail: input.detail ?? {},
  });
}

/** Writes a state-change event (deduplicated by violation signature) and prunes old events. */
export async function recordWatchdogEvents(evaluation: WatchdogEvaluation, now = new Date()) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const signature = evaluationViolationSignature(evaluation);
  const { data: latest, error } = await supabase
    .from("admin_ops_events")
    .select("event_type, detail")
    .order("created_at", { ascending: false })
    .limit(1);
  const latestDetail = record(latest?.[0]?.detail);
  if (!error && latestDetail?.signature === signature) {
    await pruneAdminOpsEvents(now);
    return;
  }
  if (evaluation.ok) {
    await recordAdminOpsEvent({
      eventType: "watchdog_ok",
      severity: "info",
      summary: "수집 운영이 정상입니다. 소스별 신선도와 실행 상태에 이상이 없습니다.",
      detail: { signature, generatedAt: evaluation.generatedAt },
    });
  } else {
    const worst = evaluation.violations.reduce<"warning" | "critical">((current, violation) =>
      violation.severity === "critical" ? "critical" : current, "warning");
    await recordAdminOpsEvent({
      eventType: "watchdog_violation",
      severity: worst,
      summary: `${evaluation.violations.length}건 위반 감지: ${evaluation.violations.map((v) => v.key).join(", ")}`,
      detail: { signature, generatedAt: evaluation.generatedAt, violations: evaluation.violations },
    });
  }
  await pruneAdminOpsEvents(now);
}
