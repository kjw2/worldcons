import Link from "next/link";
import { redirect } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { IngestionStatusPanel } from "@/components/ingestion-status-panel";
import { countOpenSourceUrlCandidates } from "@/lib/db/source-url-candidates";
import { listIngestionRuns } from "@/lib/db/queries";
import { displaySourceLabel } from "@/lib/ui/source-labels";
import { isAuthorizedPageRequest } from "@/lib/utils/auth";
import { evaluateWatchdog, listAdminOpsEvents, type AdminOpsEvent, type WatchdogSourceStatus, type WatchdogViolation } from "@/lib/ops/watchdog";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const EVENT_TYPE_LABELS: Record<string, string> = {
  watchdog_ok: "정상 확인",
  watchdog_violation: "위반 감지",
  watchdog_compensation: "보정 수집",
  watchdog_issue_filed: "경고 발행",
  watchdog_issue_updated: "경고 갱신",
  watchdog_issue_closed: "경고 종료",
  watchdog_error: "오류",
};

const SEVERITY_LABELS: Record<string, string> = {
  info: "정보",
  warning: "경고",
  critical: "치명",
};

function formatDateTime(input?: string | null) {
  if (!input) return "-";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return input;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function freshnessLabel(seconds: number | null) {
  if (seconds === null) return "-";
  const hours = seconds / 3600;
  if (hours < 1) return `${Math.floor(seconds / 60)}분 전`;
  return `${Math.floor(hours)}시간 전`;
}

function severityTone(severity: string) {
  if (severity === "critical") return "border-court/25 bg-court/5 text-court";
  if (severity === "warning") return "border-amber-400/40 bg-amber-50 text-amber-800";
  return "border-mint/25 bg-mint/10 text-mint";
}

function SourceStatusTable({ sources }: { sources: WatchdogSourceStatus[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-white">
      <table className="min-w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs uppercase text-ink/45">
            <th className="px-4 py-3 font-semibold">소스</th>
            <th className="px-4 py-3 font-semibold">마지막 실행</th>
            <th className="px-4 py-3 font-semibold">결과</th>
            <th className="px-4 py-3 font-semibold">신선도</th>
            <th className="px-4 py-3 font-semibold">신규/갱신/미수집</th>
            <th className="px-4 py-3 font-semibold">상태</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => {
            const healthy = source.healthy;
            return (
              <tr key={source.sourceKey} className="border-b border-line/60 last:border-0">
                <td className="px-4 py-3 font-semibold text-ink">{displaySourceLabel(source.sourceKey)}</td>
                <td className="px-4 py-3 text-ink/66">{formatDateTime(source.lastRunStartedAt)}</td>
                <td className="px-4 py-3 text-ink/66">{source.lastRunOutcome ?? source.lastRunStatus ?? "-"}</td>
                <td className="px-4 py-3 text-ink/66">{freshnessLabel(source.freshnessSeconds)}</td>
                <td className="px-4 py-3 text-ink/66">
                  {source.addedCount ?? "-"}/{source.refreshedCount ?? "-"}/{source.uncollectedCount ?? "-"}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex min-h-6 items-center rounded-md border px-2 text-xs font-semibold ${
                      healthy ? "border-mint/25 bg-mint/10 text-mint" : "border-amber-400/40 bg-amber-50 text-amber-800"
                    }`}
                  >
                    {healthy ? "정상" : "주의"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ViolationList({ violations }: { violations: WatchdogViolation[] }) {
  if (violations.length === 0) {
    return (
      <div className="rounded-lg border border-mint/25 bg-mint/10 px-4 py-3 text-sm font-semibold text-mint">
        감지된 위반 사항이 없습니다.
      </div>
    );
  }
  return (
    <ul className="grid gap-2">
      {violations.map((violation) => (
        <li key={violation.key} className={`rounded-lg border px-4 py-3 text-sm ${severityTone(violation.severity)}`}>
          <span className="font-semibold">
            [{violation.severity === "critical" ? "치명" : "경고"}] {violation.key}
          </span>
          <span className="ml-2">{violation.summary}</span>
        </li>
      ))}
    </ul>
  );
}

function EventTimeline({ events }: { events: AdminOpsEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-ink/58">아직 기록된 운영 이벤트가 없습니다. 워치독이 상태 변화를 감지하면 여기에 표시됩니다.</p>;
  }
  return (
    <ul className="grid gap-2">
      {events.map((event) => (
        <li key={event.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-white px-3 py-2.5 text-sm">
          <span className={`inline-flex min-h-6 items-center rounded-md border px-2 text-xs font-semibold ${severityTone(event.severity)}`}>
            {SEVERITY_LABELS[event.severity] ?? event.severity}
          </span>
          <span className="font-semibold text-ink">{EVENT_TYPE_LABELS[event.event_type] ?? event.event_type}</span>
          <span className="min-w-0 flex-1 text-ink/66">{event.summary}</span>
          <span className="shrink-0 text-xs text-ink/45">{formatDateTime(event.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}

function RunbookSection() {
  const items = [
    { title: "정기 확인", body: "주 1~2회 이 페이지에서 소스별 신선도와 위반 사항을 확인합니다. 미수집 URL 후보는 /admin/candidates에서 관리합니다." },
    { title: "알림 수신 시", body: "GitHub 이슈([무인운영] 수집 경고) 본문 → 이 페이지에서 원인 확인 → 수동 재실행이 필요하면 GitHub Actions의 Crawlee worker ingest 워크플로를 workflow_dispatch로 실행하거나 /admin/candidates에서 후보를 재시도합니다. 복구되면 워치독이 이슈를 자동으로 닫습니다." },
    { title: "수집 일시정지/재개", body: "일시정지는 MasterDash 컨트롤(pause_collection/resume_collection)로만 가능합니다. 일시정지 중에는 보정 수집이 실행되지 않습니다." },
    { title: "자동 동작 요약", body: "워치독이 15분마다 평가하고 상태 변화 시 GitHub 이슈로 알립니다. 24시간 내 완료 실행이 없으면 보정 수집(limit 5/소스)을 자동 실행합니다. Vercel 크론이 하루 2회(03:00/15:00 UTC) 독립 점검합니다." },
  ];
  return (
    <section aria-labelledby="runbook-heading">
      <h2 id="runbook-heading" className="mb-3 text-base font-semibold text-ink">
        운영 지침
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.title} className="rounded-lg border border-line bg-white px-4 py-3">
            <p className="text-sm font-semibold text-ink">{item.title}</p>
            <p className="mt-1 text-sm leading-6 text-ink/66">{item.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default async function AdminOpsPage() {
  if (!(await isAuthorizedPageRequest())) {
    redirect(`/admin/login?next=${encodeURIComponent("/admin/ops")}`);
  }

  const [evaluation, runs, events, pendingCandidateCount] = await Promise.all([
    evaluateWatchdog(),
    listIngestionRuns(12),
    listAdminOpsEvents(20),
    countOpenSourceUrlCandidates(),
  ]);

  const overallTone = evaluation.ok
    ? "border-mint/25 bg-mint/10 text-mint"
    : evaluation.violations.some((violation) => violation.severity === "critical")
      ? "border-court/25 bg-court/5 text-court"
      : "border-amber-400/40 bg-amber-50 text-amber-800";
  const overallLabel = evaluation.ok ? "정상" : evaluation.violations.some((violation) => violation.severity === "critical") ? "위반 (치명)" : "위반 (경고)";

  return (
    <div className="min-w-0 px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-court">시스템</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink">무인운영 현황</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink/66">
            수집 운영 상태를 자동 평가한 결과입니다. 워치독이 15분마다 소스별 신선도와 실행 결과를 점검하고, 이상이 지속되면 GitHub 이슈로 알립니다.
          </p>
        </div>
        <Link href="/admin/ops" className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink/90">
          <RefreshCw className="size-4" aria-hidden="true" />
          새로고침
        </Link>
      </div>

      <div className="grid gap-6">
        <div className={`rounded-lg border px-4 py-4 text-sm ${overallTone}`}>
          <p className="font-semibold">
            전체 상태: {overallLabel}
            {evaluation.paused ? " (수집 일시정지 중)" : ""}
          </p>
          <p className="mt-1 opacity-80">
            평가 시각 {formatDateTime(evaluation.generatedAt)} · 위반 {evaluation.violations.length}건 · 미수집 URL 후보 {pendingCandidateCount}건 · 마지막 완료 실행{" "}
            {formatDateTime(evaluation.lastCompletedRunAt)}
          </p>
        </div>

        <section aria-labelledby="source-health-heading">
          <h2 id="source-health-heading" className="mb-3 text-base font-semibold text-ink">
            소스별 수집 상태
          </h2>
          <SourceStatusTable sources={evaluation.sources} />
        </section>

        <section aria-labelledby="violations-heading">
          <h2 id="violations-heading" className="mb-3 text-base font-semibold text-ink">
            위반 사항
          </h2>
          <ViolationList violations={evaluation.violations} />
        </section>

        <section aria-labelledby="runs-heading">
          <h2 id="runs-heading" className="mb-3 text-base font-semibold text-ink">
            최근 수집 실행
          </h2>
          <IngestionStatusPanel runs={runs} />
        </section>

        <section aria-labelledby="events-heading">
          <h2 id="events-heading" className="mb-3 text-base font-semibold text-ink">
            최근 운영 이벤트
          </h2>
          <EventTimeline events={events} />
        </section>

        <RunbookSection />
      </div>
    </div>
  );
}
