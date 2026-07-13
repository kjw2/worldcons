import { getSupabaseServiceRoleAdmin } from "@/lib/db/client";
import { adminStateLabel, commandStage, lifecycleStage } from "@/lib/admin/p4/labels";
import type {
  AdminWorkFilters,
  AdminWorkItem,
  AdminWorkItemDetail,
  AdminWorkQueueSnapshot,
  AdminWorkSlaFilter,
  AdminWorkTimelineEvent,
  AdminWorkType,
} from "@/lib/admin/p4/types";
import { redactAdminAuditText } from "@/lib/security/audit-redaction";
import {
  BVERFG_LIVE_DISCOVERY_EMPTY,
  BVERFG_OFFICIAL_DETAIL_404,
} from "@/lib/ui/candidate-tracking-labels";

type Row = Record<string, unknown>;
type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseServiceRoleAdmin>>;

const MAX_ROWS_PER_DOMAIN = 500;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>'"`]+/gi;

export const ADMIN_WORK_QUERY_CONTRACT = {
  maxQueueQueries: 9,
  perRowQueries: 0,
  maxRowsPerDomain: MAX_ROWS_PER_DOMAIN,
  detailUsesExactPrimaryKey: true,
  maxDetailQueries: 8,
} as const;

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relation(value: unknown) {
  if (Array.isArray(value)) return isRecord(value[0]) ? value[0] : {};
  return isRecord(value) ? value : {};
}

function text(row: Row, key: string) {
  return typeof row[key] === "string" ? row[key] as string : null;
}

function number(row: Row, key: string) {
  const value = row[key];
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateOrNow(value?: string | null) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function addMinutes(value: string, minutes: number) {
  return new Date(new Date(value).getTime() + minutes * 60_000).toISOString();
}

export function redactOperationalText(value?: string | null) {
  if (!value) return null;
  return redactAdminAuditText(value, 300).replace(URL_PATTERN, "[redacted-url]");
}

function slaState(dueAt: string, now = Date.now()) {
  const due = new Date(dueAt).getTime();
  if (!Number.isFinite(due) || due <= now) return "breached" as const;
  if (due - now <= 60 * 60_000) return "due" as const;
  return "healthy" as const;
}

function lifecycleValue(row: Row) {
  return [text(row, "lifecycle_collection_state"), text(row, "lifecycle_processing_state"), text(row, "lifecycle_review_state")]
    .filter(Boolean)
    .join(" / ") || "not linked";
}

function rowLimit(filters: AdminWorkFilters) {
  return Math.min(MAX_ROWS_PER_DOMAIN, filters.page * filters.pageSize + filters.pageSize + 1);
}

async function safeRows(load: () => PromiseLike<{ data: unknown; error: unknown }>, warning: string, warnings: string[]) {
  try {
    const { data, error } = await load();
    if (error) {
      warnings.push(warning);
      return [] as Row[];
    }
    return Array.isArray(data) ? data.filter(isRecord) : [];
  } catch {
    warnings.push(warning);
    return [] as Row[];
  }
}

async function safeRowsResult(load: () => PromiseLike<{ data: unknown; error: unknown }>, warning: string, warnings: string[]) {
  try {
    const { data, error } = await load();
    if (error) {
      warnings.push(warning);
      return { rows: [] as Row[], available: false };
    }
    return { rows: Array.isArray(data) ? data.filter(isRecord) : [], available: true };
  } catch {
    warnings.push(warning);
    return { rows: [] as Row[], available: false };
  }
}

function executionWorkItem(run: Row, attempt: Row = {}): AdminWorkItem {
  const id = text(run, "id") ?? "unknown";
  const command = relation(run.admin_commands);
  const status = text(run, "status") ?? "unknown";
  const commandType = text(command, "command_type") ?? "관리자 명령";
  const updatedAt = dateOrNow(text(run, "updated_at") ?? text(run, "created_at"));
  const dueAt = addMinutes(updatedAt, status === "running" ? 5 : 30);
  const leaseExpiresAt = text(attempt, "lease_expires_at");
  const stale = status === "running" && Boolean(leaseExpiresAt && new Date(leaseExpiresAt).getTime() <= Date.now());
  const latestError = redactOperationalText(text(attempt, "error_message") ?? text(run, "terminal_error_message"));
  return {
    id,
    type: "execution",
    stage: commandStage(commandType),
    title: commandType,
    target: `실행 ${number(run, "run_number") || 1}`,
    source: null,
    owner: text(attempt, "worker_id") ?? text(command, "requested_by"),
    execution: adminStateLabel(stale ? "lease_expired" : status),
    lifecycle: adminStateLabel(),
    publication: adminStateLabel(),
    attention: stale || ["failed", "aborted"].includes(status) || Boolean(text(run, "abort_requested_at")),
    attentionCode: stale ? "lease_expired" : text(attempt, "error_code") ?? text(run, "terminal_error_code"),
    createdAt: dateOrNow(text(run, "created_at")),
    updatedAt,
    slaDueAt: dueAt,
    slaState: slaState(dueAt),
    latestError,
    attempts: Math.max(number(attempt, "attempt_number"), number(run, "retry_count")),
    compatibility: status === "shadowed",
    detailHref: `/admin/work/execution/${encodeURIComponent(id)}`,
    safeAction: ["queued", "running", "retry_wait"].includes(status) ? "abort" : ["failed", "aborted"].includes(status) ? "retry" : null,
    actionDisabledReason: status === "shadowed" ? "호환 기록은 종료 상태이므로 실행할 수 없습니다." : null,
  };
}

async function loadExecutionItems(supabase: SupabaseAdmin, limit: number, warnings: string[]) {
  const runs = await safeRows(
    () => supabase
      .from("admin_command_runs")
      .select("id,command_id,run_number,status,priority,available_at,retry_count,current_attempt_id,abort_requested_at,started_at,finished_at,terminal_error_code,terminal_error_message,created_at,updated_at,admin_commands!inner(command_type,requested_by,created_at)")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(limit),
    "P0 명령을 조회할 수 없어 호환 업무만 표시합니다.",
    warnings,
  );
  if (runs.length === 0) return { items: [] as AdminWorkItem[], truncated: false };

  const runIds = runs.map((row) => text(row, "id")).filter(Boolean) as string[];
  const attempts = await safeRows(
    () => supabase
      .from("admin_command_attempts")
      .select("id,run_id,attempt_number,status,worker_id,fencing_token,lease_expires_at,heartbeat_at,error_code,error_message,started_at,finished_at")
      .in("run_id", runIds)
      .order("attempt_number", { ascending: false })
      .limit(Math.min(MAX_ROWS_PER_DOMAIN * 3, Math.max(limit * 3, 50))),
    "P0 실행 시도 측정정보를 조회할 수 없습니다.",
    warnings,
  );
  const attemptByRun = new Map<string, Row>();
  for (const attempt of attempts) {
    const runId = text(attempt, "run_id");
    if (runId && !attemptByRun.has(runId)) attemptByRun.set(runId, attempt);
  }

  const items = runs.map((run) => executionWorkItem(run, attemptByRun.get(text(run, "id") ?? "") ?? {}));
  return { items, truncated: runs.length >= limit };
}

function articleWorkItem(row: Row, publication: Row = {}): AdminWorkItem {
  const id = text(row, "id") ?? "unknown";
  const publicationState = text(publication, "state");
  const processing = text(row, "lifecycle_processing_state");
  const review = text(row, "lifecycle_review_state") ?? text(row, "review_state");
  const attentionState = text(row, "lifecycle_attention_state");
  const attention = ["active", "anomaly"].includes(attentionState ?? "") || review === "needs_review" || Boolean(text(row, "error_class"));
  const updatedAt = dateOrNow(text(row, "updated_at") ?? text(row, "created_at"));
  const dueAt = addMinutes(updatedAt, attention ? 24 * 60 : 7 * 24 * 60);
  const eligible = text(row, "lifecycle_collection_state") === "source_text_ready"
    && processing === "complete"
    && ["unreviewed", "approved"].includes(review ?? "")
    && attentionState === "clear";
  const safeAction = publicationState === "published"
    ? "withdraw" as const
    : eligible && ["in_review", "withdrawn"].includes(publicationState ?? "")
      ? "publish" as const
      : null;
  return {
    id,
    type: "article",
    stage: publicationState ? "publish" : lifecycleStage(processing, review),
    title: text(row, "korean_title") ?? text(row, "original_title") ?? "제목 없는 기사",
    target: text(row, "slug") ?? id,
    source: text(row, "source_key"),
    owner: null,
    execution: adminStateLabel(),
    lifecycle: adminStateLabel(lifecycleValue(row) === "not linked" ? text(row, "status") : lifecycleValue(row)),
    publication: adminStateLabel(publicationState),
    attention,
    attentionCode: text(row, "lifecycle_attention_code") ?? text(row, "error_class"),
    createdAt: dateOrNow(text(row, "created_at") ?? text(row, "updated_at")),
    updatedAt,
    slaDueAt: dueAt,
    slaState: slaState(dueAt),
    latestError: redactOperationalText(text(row, "lifecycle_attention_code") ?? text(row, "error_class")),
    attempts: 0,
    compatibility: !text(row, "lifecycle_collection_state") || !publicationState,
    detailHref: `/admin/work/article/${encodeURIComponent(id)}`,
    safeAction,
    actionDisabledReason: safeAction
      ? null
      : publicationState === "draft"
        ? "초안은 승인된 권한을 통해 검토 단계에 들어가야 공개할 수 있습니다."
        : !eligible
          ? "수집, 처리, 검토 또는 주의 상태가 공개 요건을 충족하지 않습니다."
          : "현재 상태에서 허용되는 공개 전환이 없습니다.",
  };
}

async function loadArticleItems(supabase: SupabaseAdmin, limit: number, warnings: string[]) {
  let rows = await safeRows(
    () => supabase
      .from("articles")
      .select("id,slug,source_key,institution_name,original_title,korean_title,status,error_class,review_state,updated_at,created_at,lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state,lifecycle_attention_state,lifecycle_attention_code,lifecycle_attention_retryable,lifecycle_attention_severity")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(limit),
    "P2 기사 처리 열을 조회할 수 없어 호환 상태를 표시합니다.",
    warnings,
  );
  if (rows.length === 0) {
    rows = await safeRows(
      () => supabase
        .from("articles")
        .select("id,slug,source_key,institution_name,original_title,korean_title,status,error_class,review_state,updated_at,created_at")
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true })
        .limit(limit),
    "기사 호환 데이터를 조회할 수 없습니다.",
      warnings,
    );
  }
  if (rows.length === 0) return { items: [] as AdminWorkItem[], truncated: false };

  const articleIds = rows.map((row) => text(row, "id")).filter(Boolean) as string[];
  const publications = await safeRows(
    () => supabase
      .from("article_publications_p3")
      .select("article_id,state,revision,updated_at")
      .in("article_id", articleIds)
      .limit(limit),
    "P3 공개 정보를 조회할 수 없어 공개 상태를 연결하지 않습니다.",
    warnings,
  );
  const publicationByArticle = new Map(publications.map((row) => [text(row, "article_id"), row]));

  const items = rows.map((row) => articleWorkItem(row, publicationByArticle.get(text(row, "id")) ?? {}));
  return { items, truncated: rows.length >= limit };
}

function candidateWorkItem(row: Row): AdminWorkItem {
  const id = text(row, "id") ?? "unknown";
  const status = text(row, "status") ?? "unknown";
  const updatedAt = dateOrNow(text(row, "updated_at") ?? text(row, "created_at"));
  const dueAt = addMinutes(updatedAt, status === "retrying" ? 30 : 24 * 60);
  return {
    id,
    type: "candidate",
    stage: "collect",
    title: text(row, "candidate_type") ?? "URL 후보",
    target: `후보 ${id.slice(0, 8)}`,
    source: text(row, "source_key"),
    owner: text(row, "discovered_by"),
    execution: adminStateLabel(),
    lifecycle: adminStateLabel(status),
    publication: adminStateLabel(),
    attention: ["pending", "retrying", "failed"].includes(status),
    attentionCode: text(row, "last_error_code"),
    createdAt: dateOrNow(text(row, "created_at")),
    updatedAt,
    slaDueAt: dueAt,
    slaState: slaState(dueAt),
    latestError: redactOperationalText(text(row, "last_error_code")) ?? (status === "failed" ? "candidate.retry_failed" : null),
    attempts: number(row, "attempt_count"),
    compatibility: true,
    detailHref: `/admin/work/candidate/${encodeURIComponent(id)}`,
    safeAction: ["pending", "failed"].includes(status) ? "candidate-retry" : null,
    actionDisabledReason: status === "retrying" ? "이미 재시도 중입니다." : ["fetched", "ignored"].includes(status) ? "종료된 후보는 다시 등록할 수 없습니다." : null,
  };
}

async function loadCandidateItems(supabase: SupabaseAdmin, limit: number, warnings: string[]) {
  const rows = await safeRows(
    () => supabase
      .from("source_url_candidates")
      .select("id,source_key,candidate_type,discovered_by,status,last_attempt_at,attempt_count,last_error_code,last_error_message,created_at,updated_at")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(limit),
    "URL 후보를 조회할 수 없습니다.",
    warnings,
  );
  const items = rows.map(candidateWorkItem);
  return { items, truncated: rows.length >= limit };
}

function outboxWorkItem(row: Row): AdminWorkItem {
  const id = text(row, "id") ?? "unknown";
  const status = text(row, "status") ?? "unknown";
  const updatedAt = dateOrNow(text(row, "updated_at") ?? text(row, "created_at"));
  const dueAt = addMinutes(text(row, "available_at") ?? updatedAt, 5);
  return {
    id,
    type: "outbox",
    stage: "publish",
    title: text(row, "event_type") ?? "publication.changed",
    target: text(row, "article_slug") ?? `기사 ${String(text(row, "article_id") ?? "").slice(0, 8)}`,
    source: null,
    owner: text(row, "lease_owner"),
    execution: adminStateLabel(status),
    lifecycle: adminStateLabel(),
    publication: adminStateLabel(text(row, "publication_state")),
    attention: ["pending", "processing", "dead_letter"].includes(status),
    attentionCode: text(row, "last_error_code"),
    createdAt: dateOrNow(text(row, "created_at")),
    updatedAt,
    slaDueAt: dueAt,
    slaState: slaState(dueAt),
    latestError: redactOperationalText(text(row, "last_error_code")),
    attempts: number(row, "attempt_count"),
    compatibility: false,
    detailHref: `/admin/work/outbox/${encodeURIComponent(id)}`,
    safeAction: null,
    actionDisabledReason: "P3에는 승인된 수동 재시도 또는 영구 실패 전환 기능이 없습니다. 제한된 캐시 전달 처리 절차를 사용하세요.",
  };
}

async function loadOutboxItems(supabase: SupabaseAdmin, limit: number, warnings: string[]) {
  const rows = await safeRows(
    () => supabase
      .from("article_cache_outbox_p3")
      .select("id,event_type,article_id,publication_id,publication_revision,version_id,publication_state,article_slug,status,attempt_count,max_attempts,available_at,lease_owner,lease_expires_at,last_error_code,delivered_at,dead_lettered_at,created_at,updated_at")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(limit),
    "P3 캐시 전달 정보를 조회할 수 없습니다.",
    warnings,
  );
  const items = rows.map(outboxWorkItem);
  return { items, truncated: rows.length >= limit };
}

function legacyWorkItem(row: Row): AdminWorkItem {
  const id = text(row, "id") ?? "unknown";
  const status = text(row, "status") ?? "unknown";
  const jobType = text(row, "job_type") ?? "호환 작업";
  const updatedAt = dateOrNow(text(row, "updated_at") ?? text(row, "requested_at") ?? text(row, "created_at"));
  const dueAt = addMinutes(updatedAt, status === "running" ? 30 : 60);
  return {
    id,
    type: "legacy",
    stage: commandStage(jobType),
    title: jobType,
    target: text(row, "article_slug") ?? text(row, "source_key") ?? `작업 ${id.slice(0, 8)}`,
    source: text(row, "source_key"),
    owner: text(row, "worker_id"),
    execution: adminStateLabel(status),
    lifecycle: adminStateLabel(),
    publication: adminStateLabel(),
    attention: ["failed", "cancel_requested"].includes(status),
    attentionCode: text(row, "error_class"),
    createdAt: dateOrNow(text(row, "requested_at") ?? text(row, "created_at")),
    updatedAt,
    slaDueAt: dueAt,
    slaState: slaState(dueAt),
    latestError: redactOperationalText(text(row, "error_class")),
    attempts: 0,
    compatibility: true,
    detailHref: `/admin/work/legacy/${encodeURIComponent(id)}`,
    safeAction: null,
    actionDisabledReason: "호환 작업은 읽기 전용으로 표시됩니다.",
  };
}

async function loadLegacyItems(supabase: SupabaseAdmin, limit: number, warnings: string[]) {
  const rows = await safeRows(
    () => supabase
      .from("admin_jobs")
      .select("id,job_type,status,source_key,article_id,article_slug,requested_at,started_at,finished_at,worker_id,progress_current,error_class,error_message,created_at,updated_at")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(limit),
    "호환 관리자 작업을 조회할 수 없습니다.",
    warnings,
  );
  const items = rows.map(legacyWorkItem);
  return { items, truncated: rows.length >= limit };
}

function ageCutoff(age: AdminWorkFilters["age"]) {
  const milliseconds = age === "1h" ? 60 * 60_000 : age === "24h" ? 24 * 60 * 60_000 : age === "7d" ? 7 * 24 * 60 * 60_000 : age === "30d" ? 30 * 24 * 60 * 60_000 : null;
  return milliseconds ? Date.now() - milliseconds : null;
}

function matchesSla(item: AdminWorkItem, filter: AdminWorkSlaFilter) {
  return filter === "all" || item.slaState === filter;
}

export function filterAndSortAdminWorkItems(items: AdminWorkItem[], filters: AdminWorkFilters) {
  const cutoff = ageCutoff(filters.age);
  const stateQuery = filters.state?.toLowerCase();
  const ownerQuery = filters.owner?.toLowerCase();
  return items
    .filter((item) => filters.scope === "all" || (filters.scope === "operations" ? item.type !== "candidate" : item.type === "candidate"))
    .filter((item) => !filters.owner || item.owner?.toLowerCase().includes(ownerQuery ?? ""))
    .filter((item) => !filters.stage || item.stage === filters.stage)
    .filter((item) => !filters.source || item.source === filters.source)
    .filter((item) => !filters.type || item.type === filters.type)
    .filter((item) => !stateQuery || [item.execution.value, item.lifecycle.value, item.publication.value, item.attentionCode].some((value) => value?.toLowerCase().includes(stateQuery)))
    .filter((item) => filters.attention === "all" || (filters.attention === "required" ? item.attention : !item.attention))
    .filter((item) => matchesSla(item, filters.sla))
    .filter((item) => cutoff === null || new Date(item.updatedAt).getTime() <= cutoff)
    .sort((left, right) => {
      if (filters.sort === "sla") {
        const due = left.slaDueAt.localeCompare(right.slaDueAt);
        if (due) return due;
      } else {
        const date = left.updatedAt.localeCompare(right.updatedAt);
        if (date) return filters.sort === "oldest" ? date : -date;
      }
      return left.type.localeCompare(right.type) || left.id.localeCompare(right.id);
    });
}

export function paginateAdminWorkItems(items: AdminWorkItem[], filters: AdminWorkFilters) {
  const start = (filters.page - 1) * filters.pageSize;
  return {
    items: items.slice(start, start + filters.pageSize),
    hasMore: start + filters.pageSize < items.length,
  };
}

export function summarizeAdminWorkItems(items: AdminWorkItem[]): AdminWorkQueueSnapshot["counts"] {
  const trackedCandidates = items.filter((item) => item.type === "candidate" && item.attention);
  const operationalItems = items.filter((item) => item.type !== "candidate");
  const candidateOfficialDetail404 = trackedCandidates.filter((item) => item.attentionCode === BVERFG_OFFICIAL_DETAIL_404).length;
  const candidateDiscoveryEmpty = trackedCandidates.filter((item) => item.attentionCode === BVERFG_LIVE_DISCOVERY_EMPTY).length;

  return {
    backlog: operationalItems.filter((item) => !["succeeded", "delivered", "fetched", "published"].includes(item.execution.value) && item.attention).length,
    breached: operationalItems.filter((item) => item.slaState === "breached" && item.attention).length,
    failed: operationalItems.filter((item) => item.execution.tone === "danger" || item.latestError).length,
    stale: operationalItems.filter((item) => item.attentionCode === "lease_expired" || item.attentionCode === "job.stale_running").length,
    abortRequested: operationalItems.filter((item) => item.execution.value === "abort_requested" || item.attentionCode === "aborted").length,
    outbox: operationalItems.filter((item) => item.type === "outbox" && item.attention).length,
    trackingCandidates: trackedCandidates.length,
    candidateOfficialDetail404,
    candidateDiscoveryEmpty,
    candidateOther: Math.max(0, trackedCandidates.length - candidateOfficialDetail404 - candidateDiscoveryEmpty),
  };
}

export async function getAdminWorkQueueSnapshot(filters: AdminWorkFilters): Promise<AdminWorkQueueSnapshot> {
  const generatedAt = new Date().toISOString();
  const supabase = getSupabaseServiceRoleAdmin();
  if (!supabase) {
    return {
      generatedAt,
      available: false,
      compatibilityMode: true,
      warnings: ["서비스 역할 데이터베이스 접근이 설정되지 않아 운영 기록을 조회하지 않았습니다."],
      items: [],
      pageInfo: { page: filters.page, pageSize: filters.pageSize, total: 0, hasMore: false, truncated: false },
      counts: {
        backlog: 0,
        breached: 0,
        failed: 0,
        stale: 0,
        abortRequested: 0,
        outbox: 0,
        trackingCandidates: 0,
        candidateOfficialDetail404: 0,
        candidateDiscoveryEmpty: 0,
        candidateOther: 0,
      },
    };
  }

  const warnings: string[] = [];
  const limit = rowLimit(filters);
  const domains = await Promise.all([
    loadExecutionItems(supabase, limit, warnings),
    loadArticleItems(supabase, limit, warnings),
    loadCandidateItems(supabase, limit, warnings),
    loadOutboxItems(supabase, limit, warnings),
    loadLegacyItems(supabase, limit, warnings),
  ]);
  const allItems = domains.flatMap((domain) => domain.items);
  const filtered = filterAndSortAdminWorkItems(allItems, filters);
  const page = paginateAdminWorkItems(filtered, filters);
  const pageItems = page.items;
  const truncated = domains.some((domain) => domain.truncated);
  return {
    generatedAt,
    available: true,
    compatibilityMode: warnings.length > 0 || allItems.some((item) => item.compatibility),
    warnings: Array.from(new Set(warnings)),
    items: pageItems,
    pageInfo: {
      page: filters.page,
      pageSize: filters.pageSize,
      total: filtered.length,
      hasMore: page.hasMore,
      truncated,
    },
    counts: summarizeAdminWorkItems(allItems),
  };
}

async function loadExactExecutionItem(supabase: SupabaseAdmin, id: string, warnings: string[]) {
  const runResult = await safeRowsResult(
    () => supabase
      .from("admin_command_runs")
      .select("id,command_id,run_number,status,priority,available_at,retry_count,current_attempt_id,abort_requested_at,started_at,finished_at,terminal_error_code,terminal_error_message,created_at,updated_at,admin_commands!inner(command_type,requested_by,created_at)")
      .eq("id", id)
      .limit(1),
    "P0 명령 상세정보를 조회할 수 없습니다.",
    warnings,
  );
  if (!runResult.available) throw new Error("P0 명령 상세정보 조회에 실패했습니다.");
  const run = runResult.rows[0];
  if (!run) return null;
  const attempts = await safeRows(
    () => supabase
      .from("admin_command_attempts")
      .select("id,run_id,attempt_number,status,worker_id,fencing_token,lease_expires_at,heartbeat_at,error_code,error_message,started_at,finished_at")
      .eq("run_id", id)
      .order("attempt_number", { ascending: false })
      .limit(1),
    "P0 실행 시도 측정정보를 조회할 수 없습니다.",
    warnings,
  );
  return executionWorkItem(run, attempts[0] ?? {});
}

async function loadExactArticleItem(supabase: SupabaseAdmin, id: string, warnings: string[]) {
  const lifecycleResult = await safeRowsResult(
    () => supabase
      .from("articles")
      .select("id,slug,source_key,institution_name,original_title,korean_title,status,error_class,review_state,updated_at,created_at,lifecycle_collection_state,lifecycle_processing_state,lifecycle_review_state,lifecycle_attention_state,lifecycle_attention_code,lifecycle_attention_retryable,lifecycle_attention_severity")
      .eq("id", id)
      .limit(1),
    "P2 기사 처리 열을 조회할 수 없어 상세 화면에 호환 상태를 표시합니다.",
    warnings,
  );
  let row = lifecycleResult.rows[0];
  if (!lifecycleResult.available) {
    const legacyResult = await safeRowsResult(
      () => supabase
        .from("articles")
        .select("id,slug,source_key,institution_name,original_title,korean_title,status,error_class,review_state,updated_at,created_at")
        .eq("id", id)
        .limit(1),
    "기사 호환 상세정보를 조회할 수 없습니다.",
      warnings,
    );
    if (!legacyResult.available) throw new Error("기사 상세정보 조회에 실패했습니다.");
    row = legacyResult.rows[0];
  }
  if (!row) return null;
  const publications = await safeRows(
    () => supabase
      .from("article_publications_p3")
      .select("article_id,state,revision,updated_at")
      .eq("article_id", id)
      .limit(1),
    "P3 공개 상세정보를 조회할 수 없어 공개 상태를 연결하지 않습니다.",
    warnings,
  );
  return articleWorkItem(row, publications[0] ?? {});
}

async function loadExactCandidateItem(supabase: SupabaseAdmin, id: string, warnings: string[]) {
  const result = await safeRowsResult(
    () => supabase
      .from("source_url_candidates")
      .select("id,source_key,candidate_type,discovered_by,status,last_attempt_at,attempt_count,last_error_code,last_error_message,created_at,updated_at")
      .eq("id", id)
      .limit(1),
    "URL 후보 상세정보를 조회할 수 없습니다.",
    warnings,
  );
  if (!result.available) throw new Error("URL 후보 상세정보 조회에 실패했습니다.");
  return result.rows[0] ? candidateWorkItem(result.rows[0]) : null;
}

async function loadExactOutboxItem(supabase: SupabaseAdmin, id: string, warnings: string[]) {
  const result = await safeRowsResult(
    () => supabase
      .from("article_cache_outbox_p3")
      .select("id,event_type,article_id,publication_id,publication_revision,version_id,publication_state,article_slug,status,attempt_count,max_attempts,available_at,lease_owner,lease_expires_at,last_error_code,delivered_at,dead_lettered_at,created_at,updated_at")
      .eq("id", id)
      .limit(1),
    "P3 캐시 전달 상세정보를 조회할 수 없습니다.",
    warnings,
  );
  if (!result.available) throw new Error("P3 캐시 전달 상세정보 조회에 실패했습니다.");
  return result.rows[0] ? outboxWorkItem(result.rows[0]) : null;
}

async function loadExactLegacyItem(supabase: SupabaseAdmin, id: string, warnings: string[]) {
  const result = await safeRowsResult(
    () => supabase
      .from("admin_jobs")
      .select("id,job_type,status,source_key,article_id,article_slug,requested_at,started_at,finished_at,worker_id,progress_current,error_class,error_message,created_at,updated_at")
      .eq("id", id)
      .limit(1),
    "호환 관리자 작업 상세정보를 조회할 수 없습니다.",
    warnings,
  );
  if (!result.available) throw new Error("호환 관리자 작업 상세정보 조회에 실패했습니다.");
  return result.rows[0] ? legacyWorkItem(result.rows[0]) : null;
}

async function loadExactDetailItem(supabase: SupabaseAdmin, type: AdminWorkType, id: string, warnings: string[]) {
  if (type === "execution") return loadExactExecutionItem(supabase, id, warnings);
  if (type === "article") return loadExactArticleItem(supabase, id, warnings);
  if (type === "candidate") return loadExactCandidateItem(supabase, id, warnings);
  if (type === "outbox") return loadExactOutboxItem(supabase, id, warnings);
  return loadExactLegacyItem(supabase, id, warnings);
}

function timelineEvent(input: {
  id: string;
  category: AdminWorkTimelineEvent["category"];
  title: string;
  state?: string | null;
  occurredAt?: string | null;
  actor?: string | null;
  reason?: string | null;
  correlationId?: string | null;
}): AdminWorkTimelineEvent {
  return {
    id: input.id,
    category: input.category,
    title: input.title,
    state: input.state ?? "recorded",
    occurredAt: dateOrNow(input.occurredAt),
    actor: redactOperationalText(input.actor),
    reason: redactOperationalText(input.reason),
    correlationId: redactOperationalText(input.correlationId),
  };
}

async function executionDetail(supabase: SupabaseAdmin, item: AdminWorkItem, warnings: string[]) {
  const [attempts, events, runRows] = await Promise.all([
    safeRows(
      () => supabase
        .from("admin_command_attempts")
        .select("id,run_id,attempt_number,status,worker_id,fencing_token,lease_expires_at,heartbeat_at,started_at,finished_at,failure_disposition,error_code,error_message")
        .eq("run_id", item.id)
        .order("attempt_number", { ascending: false })
        .limit(100),
      "실행 시도 이력을 조회할 수 없습니다.",
      warnings,
    ),
    safeRows(
      () => supabase
        .from("admin_command_events")
        .select("id,event_type,actor_type,actor_id,occurred_at")
        .eq("run_id", item.id)
        .order("occurred_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(200),
      "명령 이벤트 이력을 조회할 수 없습니다.",
      warnings,
    ),
    safeRows(
      () => supabase
        .from("admin_command_runs")
        .select("id,status,abort_requested_at,abort_requested_by,abort_reason,created_at,updated_at")
        .eq("id", item.id)
        .limit(1),
      "명령 실행 상태정보를 조회할 수 없습니다.",
      warnings,
    ),
  ]);
  const latestAttempt = attempts[0] ?? {};
  const run = runRows[0] ?? {};
  const timeline = [
    ...events.map((row) => timelineEvent({
      id: String(row.id ?? "event"),
      category: "execution",
      title: text(row, "event_type") ?? "명령 이벤트",
      state: text(row, "event_type"),
      occurredAt: text(row, "occurred_at"),
      actor: [text(row, "actor_type"), text(row, "actor_id")].filter(Boolean).join(": "),
    })),
    ...attempts.map((row) => timelineEvent({
      id: text(row, "id") ?? `attempt-${number(row, "attempt_number")}`,
      category: "execution",
      title: `실행 시도 ${number(row, "attempt_number")}`,
      state: text(row, "status"),
      occurredAt: text(row, "finished_at") ?? text(row, "started_at"),
      actor: text(row, "worker_id"),
      reason: text(row, "error_message") ?? text(row, "error_code") ?? text(row, "failure_disposition"),
    })),
  ];
  return {
    timeline,
    heartbeatAt: text(latestAttempt, "heartbeat_at"),
    leaseExpiresAt: text(latestAttempt, "lease_expires_at"),
    fencingToken: latestAttempt.fencing_token === undefined ? null : String(latestAttempt.fencing_token),
    abortRequestedAt: text(run, "abort_requested_at"),
    links: [
      { href: "/admin/ingestion-runs", label: "수집 실행 기록" },
      { href: `/admin/audit?q=${encodeURIComponent(item.id)}`, label: "감사 로그 검색" },
    ],
  };
}

async function articleDetail(supabase: SupabaseAdmin, item: AdminWorkItem, warnings: string[]) {
  const [lifecycle, versions, publication, audit, outbox] = await Promise.all([
    safeRows(
      () => supabase
        .from("article_lifecycle_events_p2")
        .select("id,from_revision,to_revision,actor_type,actor_id,transition_source,reason_code,applied,collection_state,processing_state,review_state,attention_state,attention_code,occurred_at")
        .eq("article_id", item.id)
        .order("occurred_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(200),
      "P2 기사 처리 이력을 조회할 수 없습니다.",
      warnings,
    ),
    safeRows(
      () => supabase
        .from("article_content_versions_p3")
        .select("id,revision,parent_version_id,provenance_actor_type,provenance_actor_id,model_ref,prompt_ref,created_at")
        .eq("article_id", item.id)
        .order("revision", { ascending: false })
        .limit(100),
      "P3 버전 이력을 조회할 수 없습니다.",
      warnings,
    ),
    safeRows(
      () => supabase
        .from("article_publication_history_p3")
        .select("id,publication_revision,from_state,to_state,actor_type,actor_id,reason,request_id,correlation_id,occurred_at")
        .eq("article_id", item.id)
        .order("occurred_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(100),
      "P3 공개 이력을 조회할 수 없습니다.",
      warnings,
    ),
    safeRows(
      () => supabase
        .from("article_audit_ledger_p3")
        .select("id,ledger_revision,event_type,actor_type,actor_id,reason,request_id,correlation_id,occurred_at")
        .eq("article_id", item.id)
        .order("occurred_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(200),
      "P3 감사 원장을 조회할 수 없습니다.",
      warnings,
    ),
    safeRows(
      () => supabase
        .from("article_cache_outbox_p3")
        .select("id,status,publication_state,publication_revision,attempt_count,last_error_code,created_at,updated_at,delivered_at,dead_lettered_at")
        .eq("article_id", item.id)
        .order("created_at", { ascending: false })
        .limit(100),
      "P3 캐시 전달 이력을 조회할 수 없습니다.",
      warnings,
    ),
  ]);
  const timeline: AdminWorkTimelineEvent[] = [
    ...lifecycle.map((row) => timelineEvent({
      id: `lifecycle-${String(row.id ?? "event")}`,
      category: "lifecycle",
      title: text(row, "transition_source") ?? "기사 처리 단계 전환",
      state: [text(row, "collection_state"), text(row, "processing_state"), text(row, "review_state"), text(row, "attention_state")].filter(Boolean).join(" / "),
      occurredAt: text(row, "occurred_at"),
      actor: [text(row, "actor_type"), text(row, "actor_id")].filter(Boolean).join(": "),
      reason: text(row, "reason_code") ?? text(row, "attention_code"),
    })),
    ...versions.map((row) => timelineEvent({
      id: `version-${text(row, "id") ?? number(row, "revision")}`,
      category: "publication",
      title: `콘텐츠 버전 ${number(row, "revision")}`,
      state: "immutable",
      occurredAt: text(row, "created_at"),
      actor: [text(row, "provenance_actor_type"), text(row, "provenance_actor_id")].filter(Boolean).join(": "),
      reason: [text(row, "model_ref"), text(row, "prompt_ref")].filter(Boolean).join(" / "),
    })),
    ...publication.map((row) => timelineEvent({
      id: `publication-${String(row.id ?? "event")}`,
      category: "publication",
      title: `공개 개정 ${number(row, "publication_revision")}`,
      state: `${text(row, "from_state") ?? "없음"} -> ${text(row, "to_state") ?? "알 수 없음"}`,
      occurredAt: text(row, "occurred_at"),
      actor: [text(row, "actor_type"), text(row, "actor_id")].filter(Boolean).join(": "),
      reason: text(row, "reason"),
      correlationId: text(row, "correlation_id") ?? text(row, "request_id"),
    })),
    ...audit.map((row) => timelineEvent({
      id: `audit-${String(row.id ?? "event")}`,
      category: "audit",
      title: text(row, "event_type") ?? "감사 이벤트",
      state: `원장 ${number(row, "ledger_revision")}`,
      occurredAt: text(row, "occurred_at"),
      actor: [text(row, "actor_type"), text(row, "actor_id")].filter(Boolean).join(": "),
      reason: text(row, "reason"),
      correlationId: text(row, "correlation_id") ?? text(row, "request_id"),
    })),
    ...outbox.map((row) => timelineEvent({
      id: `outbox-${text(row, "id") ?? "event"}`,
      category: "outbox",
      title: `캐시 전달 개정 ${number(row, "publication_revision")}`,
      state: text(row, "status"),
      occurredAt: text(row, "delivered_at") ?? text(row, "dead_lettered_at") ?? text(row, "updated_at") ?? text(row, "created_at"),
      reason: text(row, "last_error_code"),
    })),
  ];
  return {
    timeline,
    heartbeatAt: null,
    leaseExpiresAt: null,
    fencingToken: null,
    abortRequestedAt: null,
    links: [
      { href: `/admin/articles/${encodeURIComponent(item.target)}`, label: "기사 검토" },
      { href: `/articles/${encodeURIComponent(item.target)}`, label: "공개 기사" },
      { href: `/admin/audit?q=${encodeURIComponent(item.target)}`, label: "감사 로그 검색" },
    ],
  };
}

async function simpleDetail(item: AdminWorkItem) {
  const timeline = [timelineEvent({
      id: item.id,
      category: item.type === "candidate" ? "lifecycle" : item.type === "outbox" ? "outbox" : "execution",
      title: item.title,
      state: item.execution.value !== "not linked" ? item.execution.value : item.lifecycle.value,
      occurredAt: item.updatedAt,
      actor: item.owner,
      reason: item.latestError ?? item.attentionCode,
    })];
  return {
    timeline,
    heartbeatAt: null,
    leaseExpiresAt: null,
    fencingToken: null,
    abortRequestedAt: null,
    links: item.type === "candidate"
      ? [{ href: `/admin/candidates?source=${encodeURIComponent(item.source ?? "")}`, label: "URL 후보" }]
      : item.type === "outbox"
        ? [{ href: `/admin/audit?q=${encodeURIComponent(item.target)}`, label: "감사 로그 검색" }]
        : [{ href: `/admin/work/legacy/${encodeURIComponent(item.id)}`, label: "호환 작업" }],
  };
}

export async function getAdminWorkItemDetailWithClient(
  supabase: SupabaseAdmin,
  type: AdminWorkType,
  id: string,
): Promise<AdminWorkItemDetail | null> {
  const warnings: string[] = [];
  const item = await loadExactDetailItem(supabase, type, id, warnings);
  if (!item) return null;
  const detail = type === "execution"
    ? await executionDetail(supabase, item, warnings)
    : type === "article"
      ? await articleDetail(supabase, item, warnings)
      : await simpleDetail(item);
  return {
    item,
    ...detail,
    timeline: detail.timeline.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id)),
    warnings: Array.from(new Set(warnings)),
  };
}

export async function getAdminWorkItemDetail(type: AdminWorkType, id: string): Promise<AdminWorkItemDetail | null> {
  const supabase = getSupabaseServiceRoleAdmin();
  return supabase ? getAdminWorkItemDetailWithClient(supabase, type, id) : null;
}
