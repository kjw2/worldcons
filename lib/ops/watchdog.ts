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
// Source text can be collected successfully while summarization stays behind, and that
// gap is what keeps an article out of the public listing. Watch it per source so a single
// backlogged jurisdiction cannot hide behind a healthy total.
const SUMMARY_BACKLOG_WARNING_COUNT = 40;
const SUMMARY_BACKLOG_CRITICAL_COUNT = 120;
const SUMMARY_BACKLOG_WARNING_AGE_HOURS = 72;
const SUMMARY_BACKLOG_STATUSES = ["cleaned", "failed_summary"] as const;
const P5_SLA_KEYS: Record<string, true> = {
  "queue.latency": true,
  "queue.heartbeat": true,
  "queue.abort": true,
  "queue.retry": true,
  "lifecycle.backlog": true,
  "lifecycle.review": true,
  "publication.parity": true,
  "outbox.delivery": true,
  "outbox.dead_letter": true,
};

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
  summaryBacklogCount: number | null;
  oldestSummaryBacklogAt: string | null;
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

export interface SummaryBacklogStatus {
  count: number;
  oldestCreatedAt: string | null;
}

// Articles whose source text is verified publishable but whose summary has not landed yet.
// These rows are collected but invisible to the public listing, so they measure the real
// gap between ingestion and publication.
async function getSummaryBacklogBySource(): Promise<Map<string, SummaryBacklogStatus>> {
  const backlog = new Map<string, SummaryBacklogStatus>();
  const supabase = getSupabaseAdmin();
  if (!supabase) return backlog;

  for (const sourceKey of INCREMENTAL_SOURCE_KEYS) {
    try {
      const { count, error } = await supabase
        .from("articles")
        .select("id", { count: "exact", head: true })
        .eq("source_key", sourceKey)
        .in("status", [...SUMMARY_BACKLOG_STATUSES])
        .contains("source_metadata", { collection: { publishable: true } });
      if (error) continue;

      const pendingCount = count ?? 0;
      let oldestCreatedAt: string | null = null;
      if (pendingCount > 0) {
        const { data: oldest } = await supabase
          .from("articles")
          .select("created_at")
          .eq("source_key", sourceKey)
          .in("status", [...SUMMARY_BACKLOG_STATUSES])
          .contains("source_metadata", { collection: { publishable: true } })
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        oldestCreatedAt = textValue(oldest?.created_at as string | null | undefined);
      }

      backlog.set(sourceKey, { count: pendingCount, oldestCreatedAt });
    } catch {
      // Backlog metrics are best-effort and must not fail the whole evaluation.
    }
  }

  return backlog;
}

export function summaryBacklogViolation(sourceKey: string, status: SummaryBacklogStatus, now: Date): WatchdogViolation | null {
  if (status.count <= 0) return null;

  const oldestMs = parseTimestamp(status.oldestCreatedAt);
  const waitingHours = oldestMs === null ? null : Math.max(0, (now.getTime() - oldestMs) / 3_600_000);
  const waitingLabel = waitingHours === null ? "" : `, 최고령 ${hoursLabel(waitingHours)} 전`;

  if (status.count >= SUMMARY_BACKLOG_CRITICAL_COUNT) {
    return {
      key: `summary-backlog:${sourceKey}`,
      severity: "critical",
      sourceKey,
      summary: `원문은 확보됐지만 요약 대기 ${status.count}건${waitingLabel} (치명 임계 ${SUMMARY_BACKLOG_CRITICAL_COUNT}건). 해당 자료는 공개 목록에 보이지 않습니다.`,
    };
  }

  const staleBeyondWindow = waitingHours !== null && waitingHours > SUMMARY_BACKLOG_WARNING_AGE_HOURS;
  if (status.count >= SUMMARY_BACKLOG_WARNING_COUNT || staleBeyondWindow) {
    return {
      key: `summary-backlog:${sourceKey}`,
      severity: "warning",
      sourceKey,
      summary: `원문은 확보됐지만 요약 대기 ${status.count}건${waitingLabel} (경고 임계 ${SUMMARY_BACKLOG_WARNING_COUNT}건 또는 ${SUMMARY_BACKLOG_WARNING_AGE_HOURS}h 초과).`,
    };
  }

  return null;
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

  const summaryBacklog = await getSummaryBacklogBySource();

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
    const backlogStatus = summaryBacklog.get(sourceKey) ?? null;
    if (backlogStatus) {
      const backlogViolation = summaryBacklogViolation(sourceKey, backlogStatus, now);
      if (backlogViolation) sourceViolations.push(backlogViolation);
    }

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
      summaryBacklogCount: backlogStatus?.count ?? null,
      oldestSummaryBacklogAt: backlogStatus?.oldestCreatedAt ?? null,
      healthy: sourceViolations.length === 0,
    });
    violations.push(...sourceViolations);
  }

  if (!paused) {
    const lastCompletedMs = parseTimestamp(lastCompletedRunAt);
    if (lastCompletedMs === null) {
      violations.push({ key: "missed-window", severity: "critical", summary: `${LOOKBACK_HOURS}시간 내 완료된 수집 실행이 없습니다.` });
    } else if (now.getTime() - lastCompletedMs > MISSED_WINDOW_HOURS * 3_600_000) {
      violations.push({
        key: "missed-window",
        severity: "critical",
        summary: `마지막 완료 수집 실행이 ${hoursLabel((now.getTime() - lastCompletedMs) / 3_600_000)} 전입니다 (기대 주기 ${MISSED_WINDOW_HOURS}h).`,
      });
    }
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
      if (!P5_SLA_KEYS[sla.key]) continue;
      if (sla.status === "critical" && sla.value !== null) {
        const unit = sla.unit === "seconds" ? "초" : sla.unit === "count" ? "건" : sla.unit;
        violations.push({
          key: `p5:${sla.key}`,
          severity: "critical",
          summary: `${sla.label}: ${sla.value}${unit} (치명 임계 ${sla.criticalThreshold}${unit}).`,
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
