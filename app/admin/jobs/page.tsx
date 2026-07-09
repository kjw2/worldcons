import Link from "next/link";
import { redirect } from "next/navigation";
import { Ban, CheckCircle2, Clock3, Hourglass, ListChecks, LogOut, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { AdminJobActions } from "@/components/admin-job-actions";
import { AdminJobDrainButton } from "@/components/admin-job-drain-button";
import { AdminTabs } from "@/components/admin-tabs";
import {
  ADMIN_JOB_STATUSES,
  ADMIN_JOB_TYPES,
  getAdminJobSummary,
  listAdminJobEvents,
  listAdminJobs,
  type AdminJobEventRecord,
  type AdminJobRecord,
  type AdminJobStatus,
  type AdminJobSummary,
  type AdminJobType,
} from "@/lib/db/admin-jobs";
import { listSources } from "@/lib/db/queries";
import { displaySourceLabel } from "@/lib/ui/source-labels";
import { createAdminCsrfToken, isAuthorizedPageRequest } from "@/lib/utils/auth";
import { getNumberSearchParam, getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const statusLabels: Record<string, string> = {
  queued: "대기",
  running: "실행 중",
  succeeded: "성공",
  failed: "실패",
  cancel_requested: "취소 요청",
  cancelled: "취소됨",
};

const jobTypeLabels: Record<string, string> = {
  ingest: "수집",
  "ingest-and-summarize": "수집+요약",
  summarize: "요약",
  "retry-summary": "요약 재시도",
  "refresh-tags": "태그 갱신",
  "article-bulk-action": "기사 일괄",
  "candidate-action": "후보 조치",
  "manual-summary-edit": "요약 수정",
  "glossary-candidates": "용어 후보",
  "llm-test": "LLM 테스트",
};

function isAdminJobStatus(value?: string): value is AdminJobStatus {
  return Boolean(value && (ADMIN_JOB_STATUSES as readonly string[]).includes(value));
}

function isAdminJobType(value?: string): value is AdminJobType {
  return Boolean(value && (ADMIN_JOB_TYPES as readonly string[]).includes(value));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatDateTime(input?: string | null) {
  if (!input) return "없음";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "없음";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function shortText(value?: string | null, head = 8, tail = 4) {
  if (!value) return "-";
  return value.length > head + tail + 3 ? `${value.slice(0, head)}...${value.slice(-tail)}` : value;
}

function searchParamsToString(params: SearchParams) {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "page") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item) next.append(key, item);
    } else if (value) {
      next.set(key, value);
    }
  }
  return next.toString();
}

function jobsHref(params: SearchParams, nextValues: Record<string, string | undefined>) {
  const next = new URLSearchParams(searchParamsToString(params));
  for (const [key, value] of Object.entries(nextValues)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  const query = next.toString();
  return query ? `/admin/jobs?${query}` : "/admin/jobs";
}

function pageHref(params: SearchParams, page: number) {
  return jobsHref(params, { page: page > 1 ? String(page) : undefined });
}

function jobEventHref(params: SearchParams, jobId: string) {
  return jobsHref(params, { jobId });
}

function statusClass(status: string) {
  if (status === "succeeded") return "border-mint/25 bg-mint/10 text-mint";
  if (status === "running") return "border-ink/15 bg-parchment text-ink/72";
  if (status === "queued") return "border-amber-400/40 bg-amber-50 text-amber-800";
  if (status === "failed") return "border-court/25 bg-court/5 text-court";
  if (status === "cancel_requested" || status === "cancelled") return "border-rule bg-parchment text-ink/58";
  return "border-rule bg-white text-ink/64";
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold ${statusClass(status)}`}>
      {statusLabels[status] ?? status}
    </span>
  );
}

function JobTypeBadge({ jobType }: { jobType: string }) {
  return (
    <span className="inline-flex min-h-7 items-center rounded-md border border-rule bg-white px-2.5 text-xs font-semibold text-ink/68">
      {jobTypeLabels[jobType] ?? jobType}
    </span>
  );
}

function SummaryCard({
  label,
  value,
  icon: Icon,
  tone = "neutral",
}: {
  label: string;
  value: number;
  icon: typeof Clock3;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "border-mint/25 bg-mint/10 text-mint"
      : tone === "danger"
        ? "border-court/25 bg-court/5 text-court"
        : tone === "warning"
          ? "border-amber-400/40 bg-amber-50 text-amber-800"
          : "border-rule bg-parchment text-ink/62";

  return (
    <section className="rounded-md border border-rule bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-ink/62">{label}</span>
        <span className={`inline-flex size-9 items-center justify-center rounded-md border ${toneClass}`}>
          <Icon className="size-4" aria-hidden="true" />
        </span>
      </div>
      <div className="mt-3 text-3xl font-semibold tracking-normal text-ink">{formatNumber(value)}</div>
    </section>
  );
}

function SummaryCards({ summary }: { summary: AdminJobSummary }) {
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
      <SummaryCard label="대기" value={summary.queued} icon={Clock3} tone="warning" />
      <SummaryCard label="실행 중" value={summary.running} icon={Hourglass} />
      <SummaryCard label="성공" value={summary.succeeded} icon={CheckCircle2} tone="success" />
      <SummaryCard label="실패" value={summary.failed} icon={TriangleAlert} tone="danger" />
      <SummaryCard label="취소 요청" value={summary.cancel_requested} icon={ListChecks} />
      <SummaryCard label="취소됨" value={summary.cancelled} icon={Ban} />
    </section>
  );
}

function JobMeta({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold text-ink/45">{label}</dt>
      <dd className="mt-1 break-words text-xs leading-5 text-ink/68">{value || "-"}</dd>
    </div>
  );
}

function JobError({ job }: { job: AdminJobRecord }) {
  if (!job.errorClass && !job.errorMessage) return <span className="text-ink/45">-</span>;
  return (
    <div className="max-w-md rounded-md border border-court/15 bg-court/5 p-2 text-xs leading-5 text-court">
      {job.errorClass ? <div className="break-words font-semibold">{job.errorClass}</div> : null}
      {job.errorMessage ? <div className="mt-1 break-words">{job.errorMessage}</div> : null}
    </div>
  );
}

function JobIdentity({ job }: { job: AdminJobRecord }) {
  return (
    <div className="min-w-0">
      <div className="break-all font-mono text-xs font-semibold text-ink">{shortText(job.id)}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <JobTypeBadge jobType={job.jobType} />
        <StatusBadge status={job.status} />
      </div>
    </div>
  );
}

function SelectedJobEvents({
  jobId,
  events,
  error,
}: {
  jobId?: string;
  events: AdminJobEventRecord[];
  error?: string;
}) {
  if (!jobId) {
    return (
      <section className="rounded-md border border-rule bg-white p-4 text-sm text-ink/62 shadow-sm">
        작업 행의 `이벤트`를 누르면 해당 작업의 최근 이벤트만 조회합니다.
      </section>
    );
  }

  return (
    <section className="rounded-md border border-rule bg-white p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-court">최근 이벤트</p>
          <h2 className="mt-1 break-all text-lg font-semibold tracking-normal text-ink">{shortText(jobId, 12, 6)}</h2>
        </div>
        <Link href="/admin/jobs" className="focus-ring inline-flex min-h-9 items-center rounded-md border border-rule px-3 text-sm font-semibold text-ink/68 hover:bg-parchment">
          선택 해제
        </Link>
      </div>
      {error ? <div className="rounded-md border border-court/25 bg-court/5 p-3 text-sm text-court">{error}</div> : null}
      {!error && events.length === 0 ? <div className="text-sm text-ink/50">기록된 이벤트가 없습니다.</div> : null}
      <div className="grid gap-2">
        {events.map((event) => (
          <article key={event.id} className="rounded-md border border-rule bg-parchment/30 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="rounded-md border border-rule bg-white px-2.5 py-1 text-xs font-semibold text-ink/68">{event.eventType}</span>
              <span className="text-xs text-ink/50">{formatDateTime(event.occurredAt)}</span>
            </div>
            {event.errorClass ? <div className="mt-2 break-words text-xs font-semibold text-court">{event.errorClass}</div> : null}
            {event.message ? <p className="mt-2 break-words text-sm leading-5 text-ink/68">{event.message}</p> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function JobCards({
  jobs,
  params,
  selectedJobId,
  csrfToken,
}: {
  jobs: AdminJobRecord[];
  params: SearchParams;
  selectedJobId?: string;
  csrfToken: string;
}) {
  return (
    <div className="grid gap-3 md:hidden">
      {jobs.map((job) => (
        <article key={job.id} className={`rounded-md border bg-white p-4 shadow-sm ${selectedJobId === job.id ? "border-court" : "border-rule"}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <JobIdentity job={job} />
            <Link href={jobEventHref(params, job.id)} className="focus-ring inline-flex min-h-8 items-center rounded-md border border-rule px-2.5 text-xs font-semibold text-ink/68 hover:bg-parchment">
              이벤트
            </Link>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3">
            <JobMeta label="source" value={job.sourceKey} />
            <JobMeta label="article" value={job.articleSlug || job.articleId} />
            <JobMeta label="요청" value={formatDateTime(job.requestedAt)} />
            <JobMeta label="시작" value={formatDateTime(job.startedAt)} />
            <JobMeta label="종료" value={formatDateTime(job.finishedAt)} />
            <JobMeta label="worker" value={job.workerId} />
            <JobMeta label="idempotency" value={job.idempotencyKey ? shortText(job.idempotencyKey, 18, 8) : "없음"} />
            <JobMeta label="progress" value={`${job.progressCurrent}${job.progressTotal ? ` / ${job.progressTotal}` : ""}`} />
          </dl>
          <div className="mt-3">
            <JobError job={job} />
          </div>
          <div className="mt-3">
            <AdminJobActions jobId={job.id} status={job.status} csrfToken={csrfToken} />
          </div>
        </article>
      ))}
    </div>
  );
}

function JobTable({
  jobs,
  params,
  selectedJobId,
  csrfToken,
}: {
  jobs: AdminJobRecord[];
  params: SearchParams;
  selectedJobId?: string;
  csrfToken: string;
}) {
  return (
    <div className="hidden overflow-x-auto rounded-md border border-rule bg-white shadow-sm md:block">
      <table className="min-w-[1420px] divide-y divide-rule text-sm">
        <thead className="bg-parchment">
          <tr className="text-left text-xs font-semibold text-ink/60">
            <th className="px-4 py-3">작업</th>
            <th className="px-4 py-3">대상</th>
            <th className="px-4 py-3">시각</th>
            <th className="px-4 py-3">worker/progress</th>
            <th className="px-4 py-3">idempotency</th>
            <th className="px-4 py-3">실패 원인</th>
            <th className="px-4 py-3">이벤트</th>
            <th className="px-4 py-3">조치</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {jobs.map((job) => (
            <tr key={job.id} className={`align-top transition hover:bg-parchment/35 ${selectedJobId === job.id ? "bg-court/5" : ""}`}>
              <td className="px-4 py-4">
                <JobIdentity job={job} />
              </td>
              <td className="px-4 py-4 text-xs leading-5 text-ink/62">
                <div className="break-all font-semibold text-ink/72">{job.sourceKey || "-"}</div>
                <div className="mt-1 break-all">{job.articleSlug || job.articleId || "-"}</div>
                {job.parentJobId ? <div className="mt-1 break-all text-ink/45">parent {shortText(job.parentJobId)}</div> : null}
              </td>
              <td className="px-4 py-4 text-xs leading-5 text-ink/58">
                <div>요청: {formatDateTime(job.requestedAt)}</div>
                <div>시작: {formatDateTime(job.startedAt)}</div>
                <div>종료: {formatDateTime(job.finishedAt)}</div>
                <div>lease: {formatDateTime(job.leaseUntil)}</div>
              </td>
              <td className="px-4 py-4 text-xs leading-5 text-ink/58">
                <div className="break-all">{job.workerId || "-"}</div>
                <div className="mt-1">
                  {job.progressCurrent}
                  {job.progressTotal ? ` / ${job.progressTotal}` : ""}
                </div>
                <div className="mt-1">priority {job.priority}</div>
              </td>
              <td className="px-4 py-4 text-xs leading-5 text-ink/58">
                {job.idempotencyKey ? (
                  <>
                    <div className="font-semibold text-ink/70">있음</div>
                    <div className="mt-1 break-all font-mono">{shortText(job.idempotencyKey, 18, 8)}</div>
                  </>
                ) : (
                  "없음"
                )}
              </td>
              <td className="px-4 py-4">
                <JobError job={job} />
              </td>
              <td className="px-4 py-4">
                <Link href={jobEventHref(params, job.id)} className="focus-ring inline-flex min-h-9 items-center rounded-md border border-rule px-3 text-xs font-semibold text-ink/68 hover:bg-parchment">
                  이벤트 보기
                </Link>
              </td>
              <td className="px-4 py-4">
                <AdminJobActions jobId={job.id} status={job.status} csrfToken={csrfToken} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UnavailableNotice({ message }: { message: string }) {
  return (
    <section className="rounded-md border border-amber-400/40 bg-amber-50 p-4 text-sm leading-6 text-amber-900 shadow-sm">
      <div className="flex items-center gap-2 font-semibold">
        <TriangleAlert className="size-4" aria-hidden="true" />
        작업 큐 테이블을 아직 읽을 수 없습니다.
      </div>
      <p className="mt-1 break-words">{message}</p>
      <p className="mt-1">운영 DB에 P2-1 migration이 적용되기 전에는 큐 모니터링만 비활성화되고, 기존 관리자 화면은 계속 동작합니다.</p>
    </section>
  );
}

export default async function AdminJobsPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const params = await resolveSearchParams(searchParams);
  const nextPath = `/admin/jobs${searchParamsToString(params) ? `?${searchParamsToString(params)}` : ""}`;
  const authorized = await isAuthorizedPageRequest();

  if (!authorized) {
    redirect(`/admin/login?next=${encodeURIComponent(nextPath)}`);
  }

  const requestedStatus = getSearchParam(params, "status");
  const requestedJobType = getSearchParam(params, "jobType");
  const sourceKey = getSearchParam(params, "sourceKey") || undefined;
  const selectedJobId = getSearchParam(params, "jobId") || undefined;
  const page = Math.max(1, Math.trunc(getNumberSearchParam(params, "page") ?? 1));
  const limit = 50;
  const offset = (page - 1) * limit;
  const status = isAdminJobStatus(requestedStatus) ? requestedStatus : undefined;
  const jobType = isAdminJobType(requestedJobType) ? requestedJobType : undefined;

  const [jobsResult, summaryResult, sources, csrfToken, eventsResult] = await Promise.all([
    listAdminJobs({ status, jobType, sourceKey, limit, offset }),
    getAdminJobSummary(),
    listSources(),
    createAdminCsrfToken(),
    selectedJobId ? listAdminJobEvents({ jobId: selectedJobId, limit: 3 }) : Promise.resolve(null),
  ]);

  const jobs = jobsResult.ok ? jobsResult.data.jobs : [];
  const total = jobsResult.ok ? jobsResult.data.total : 0;
  const summary = summaryResult.ok
    ? summaryResult.data
    : {
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        cancel_requested: 0,
        cancelled: 0,
        total: 0,
      };
  const events = eventsResult?.ok ? eventsResult.data : [];
  const unavailableMessage =
    (!jobsResult.ok && jobsResult.unavailable ? jobsResult.error : null) ??
    (!summaryResult.ok && summaryResult.unavailable ? summaryResult.error : null);
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-sm font-semibold text-court">관리자</p>
          <h1 className="text-3xl font-semibold tracking-normal text-ink">작업 큐</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink/66">
            관리자 화면에서 등록된 수집·요약·태그 갱신 작업의 상태와 실패 원인, 최근 이벤트를 확인합니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={pageHref(params, page)} className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink/90">
            <RefreshCw className="size-4" aria-hidden="true" />
            새로고침
          </Link>
          <form action="/api/admin/logout" method="post">
            <input type="hidden" name="csrfToken" value={csrfToken ?? ""} />
            <button type="submit" className="focus-ring inline-flex items-center gap-2 rounded-md border border-rule bg-white px-4 py-2 text-sm font-semibold text-ink/72 hover:bg-parchment">
              <LogOut className="size-4" aria-hidden="true" />
              로그아웃
            </button>
          </form>
        </div>
      </div>

      <AdminTabs active="jobs" />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="grid gap-4">
          {unavailableMessage ? <UnavailableNotice message={unavailableMessage} /> : null}
          <SummaryCards summary={summary} />
        </div>
        <AdminJobDrainButton csrfToken={csrfToken ?? ""} endpoint="/api/admin/jobs/run" />
      </div>

      <form action="/admin/jobs" className="mt-5 grid gap-3 rounded-md border border-rule bg-white p-4 shadow-sm lg:grid-cols-[180px_220px_minmax(220px,1fr)_auto_auto]">
        <label className="grid gap-1 text-sm font-medium text-ink/72">
          status
          <select name="status" defaultValue={status ?? ""} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink">
            <option value="">전체</option>
            {ADMIN_JOB_STATUSES.map((item) => (
              <option key={item} value={item}>
                {statusLabels[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium text-ink/72">
          job type
          <select name="jobType" defaultValue={jobType ?? ""} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink">
            <option value="">전체</option>
            {ADMIN_JOB_TYPES.map((item) => (
              <option key={item} value={item}>
                {jobTypeLabels[item] ?? item}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium text-ink/72">
          source
          <select name="sourceKey" defaultValue={sourceKey ?? ""} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink">
            <option value="">전체</option>
            {sources.map((source) => (
              <option key={source.sourceKey} value={source.sourceKey}>
                {displaySourceLabel(source)} · {source.sourceKey}
              </option>
            ))}
          </select>
        </label>
        <input type="hidden" name="jobId" value={selectedJobId ?? ""} />
        <div className="flex items-end gap-2">
          <button type="submit" className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white hover:bg-ink/90">
            <Search className="size-4" aria-hidden="true" />
            조회
          </button>
          <Link href="/admin/jobs" className="focus-ring inline-flex h-10 items-center rounded-md border border-rule px-4 text-sm font-semibold text-ink/68 hover:bg-parchment">
            초기화
          </Link>
        </div>
      </form>

      <div className="mt-5 grid gap-4">
        <SelectedJobEvents
          jobId={selectedJobId}
          events={events}
          error={eventsResult && !eventsResult.ok ? eventsResult.error : undefined}
        />

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-ink/58">
              총 {formatNumber(total)}건 중 {formatNumber(jobs.length)}건 표시 · page {formatNumber(page)} / {formatNumber(totalPages)}
            </div>
            <div className="flex flex-wrap gap-2">
              {page > 1 ? (
                <Link href={pageHref(params, page - 1)} className="focus-ring inline-flex min-h-9 items-center rounded-md border border-rule px-3 text-sm font-semibold text-ink/68 hover:bg-parchment">
                  이전
                </Link>
              ) : null}
              {page < totalPages ? (
                <Link href={pageHref(params, page + 1)} className="focus-ring inline-flex min-h-9 items-center rounded-md border border-rule px-3 text-sm font-semibold text-ink/68 hover:bg-parchment">
                  다음
                </Link>
              ) : null}
            </div>
          </div>
          {jobs.length === 0 ? (
            <div className="rounded-md border border-rule bg-white p-6 text-sm text-ink/58 shadow-sm">표시할 작업이 없습니다.</div>
          ) : (
            <>
              <JobCards jobs={jobs} params={params} selectedJobId={selectedJobId} csrfToken={csrfToken ?? ""} />
              <JobTable jobs={jobs} params={params} selectedJobId={selectedJobId} csrfToken={csrfToken ?? ""} />
            </>
          )}
        </section>
      </div>
    </main>
  );
}
