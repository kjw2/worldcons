import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  Clock3,
  Database,
  FileWarning,
  KeyRound,
  Link2,
  ListChecks,
  LogOut,
  Newspaper,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { AdminTabs } from "@/components/admin-tabs";
import { getAdminDashboardData } from "@/lib/db/admin-queries";
import type { IngestionRunRecord } from "@/lib/db/types";
import { listIngestionRuns } from "@/lib/db/queries";
import { displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";
import { createAdminCsrfToken, isAuthorizedPageRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type DashboardData = Awaited<ReturnType<typeof getAdminDashboardData>>;
type SourceSummary = DashboardData["sourceSummaries"][number];
type CandidateSummary = DashboardData["candidateSummaries"][number];
type RunTone = "success" | "warning" | "danger" | "running" | "neutral";

const runStatusLabels: Record<string, string> = {
  completed: "완료",
  running: "실행 중",
  failed: "실패",
  partial: "부분 완료",
};

function formatNumber(value?: number | null) {
  return new Intl.NumberFormat("ko-KR").format(value ?? 0);
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

function adminArticlesHref(sourceKey?: string, status?: string) {
  const params = new URLSearchParams();
  if (sourceKey) params.set("sourceKey", sourceKey);
  if (status) params.set("status", status);
  const query = params.toString();
  return query ? `/admin/articles?${query}` : "/admin/articles";
}

function adminCandidatesHref(sourceKey?: string, status?: string) {
  const params = new URLSearchParams();
  if (sourceKey) params.set("source", sourceKey);
  if (status) params.set("status", status);
  const query = params.toString();
  return query ? `/admin/candidates?${query}` : "/admin/candidates";
}

function adminAuditHref(sourceKey?: string) {
  return sourceKey ? `/admin/audit?q=${encodeURIComponent(sourceKey)}` : "/admin/audit";
}

function statusCount(dashboard: DashboardData, status: string) {
  return dashboard.statusCounts.find((item) => item.status === status)?.count ?? 0;
}

function candidateActionCount(candidate?: CandidateSummary) {
  if (!candidate) return 0;
  return candidate.pendingCount + candidate.retryingCount + candidate.failedCount;
}

function uncollectedCandidateCount(run: IngestionRunRecord) {
  const candidates = run.metadata?.uncollectedCandidates;
  return Array.isArray(candidates) ? candidates.length : 0;
}

function isProblemRun(run: IngestionRunRecord) {
  return run.status === "failed" || run.status === "partial" || run.failedCount > 0 || Boolean(run.errorMessage) || uncollectedCandidateCount(run) > 0;
}

function runTone(run: IngestionRunRecord): RunTone {
  if (run.status === "running") return "running";
  if (run.status === "failed" || run.failedCount > 0 || run.errorMessage) return "danger";
  if (run.status === "partial" || uncollectedCandidateCount(run) > 0) return "warning";
  if (run.status === "completed") return "success";
  return "neutral";
}

function toneClassName(tone: RunTone) {
  if (tone === "success") return "border-mint/25 bg-mint/10 text-mint";
  if (tone === "running") return "border-ink/15 bg-parchment text-ink/72";
  if (tone === "warning") return "border-amber-400/40 bg-amber-50 text-amber-800";
  if (tone === "danger") return "border-court/25 bg-court/5 text-court";
  return "border-rule bg-white text-ink/64";
}

function ActionLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className="focus-ring inline-flex min-h-8 items-center rounded-md border border-rule bg-white px-2.5 text-xs font-semibold text-ink/68 hover:bg-parchment">
      {children}
    </Link>
  );
}

function MetricAction({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className="focus-ring inline-flex min-h-8 items-center rounded-md bg-ink px-2.5 text-xs font-semibold text-white hover:bg-ink/90">
      {children}
    </Link>
  );
}

function RunStatusBadge({ run }: { run: IngestionRunRecord }) {
  return (
    <span className={`inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold ${toneClassName(runTone(run))}`}>
      {runStatusLabels[run.status] ?? run.status}
    </span>
  );
}

function TriageMetric({
  title,
  value,
  detail,
  icon: Icon,
  actions,
}: {
  title: string;
  value: number;
  detail: string;
  icon: LucideIcon;
  actions: Array<{ label: string; href: string }>;
}) {
  return (
    <section className="rounded-md border border-rule bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink/62">{title}</p>
          <div className="mt-2 text-3xl font-semibold tracking-normal text-ink">{formatNumber(value)}</div>
        </div>
        <span className="inline-flex size-9 items-center justify-center rounded-md border border-rule bg-parchment text-court">
          <Icon className="size-4" aria-hidden="true" />
        </span>
      </div>
      <p className="mt-2 text-xs leading-5 text-ink/56">{detail}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {actions.map((action) => (
          <MetricAction key={`${title}:${action.label}`} href={action.href}>
            {action.label}
          </MetricAction>
        ))}
      </div>
    </section>
  );
}

function SourceStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-rule bg-parchment/45 px-3 py-2">
      <div className="text-xs font-medium text-ink/52">{label}</div>
      <div className="mt-1 text-lg font-semibold tracking-normal text-ink">{formatNumber(value)}</div>
    </div>
  );
}

function sourceActionScore(source: SourceSummary, candidate?: CandidateSummary, latestProblemRun?: IngestionRunRecord) {
  return source.pendingSummaryCount + source.attentionCount + source.failedCount + candidateActionCount(candidate) + (latestProblemRun ? 5 : 0);
}

function SourceActionCards({
  sources,
  candidatesBySource,
  problemRuns,
}: {
  sources: SourceSummary[];
  candidatesBySource: Map<string, CandidateSummary>;
  problemRuns: IngestionRunRecord[];
}) {
  const sortedSources = [...sources].sort((left, right) => {
    const leftProblem = problemRuns.find((run) => run.sourceKey === left.sourceKey);
    const rightProblem = problemRuns.find((run) => run.sourceKey === right.sourceKey);
    const scoreDiff =
      sourceActionScore(right, candidatesBySource.get(right.sourceKey), rightProblem) -
      sourceActionScore(left, candidatesBySource.get(left.sourceKey), leftProblem);
    return scoreDiff || left.sourceKey.localeCompare(right.sourceKey);
  });

  return (
    <section className="rounded-md border border-rule bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-court">source별 조치</p>
          <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">처리 우선순위</h2>
        </div>
        <Link href="/admin/articles" className="focus-ring inline-flex min-h-9 items-center gap-2 rounded-md border border-rule px-3 text-sm font-semibold text-ink/68 hover:bg-parchment">
          기사 관리
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {sortedSources.map((source) => {
          const candidate = candidatesBySource.get(source.sourceKey);
          const latestProblemRun = problemRuns.find((run) => run.sourceKey === source.sourceKey);
          const candidateCount = candidateActionCount(candidate);
          return (
            <article key={source.sourceKey} className="rounded-md border border-rule bg-parchment/25 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold tracking-normal text-ink">{displaySourceLabel({ sourceKey: source.sourceKey, name: source.name })}</h3>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink/52">
                    <span>{source.sourceKey}</span>
                    <span>{displayJurisdictionLabel(source.jurisdiction)}</span>
                    <span>{source.isActive ? "active" : "inactive"}</span>
                  </div>
                </div>
                <span className={`inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold ${latestProblemRun ? toneClassName(runTone(latestProblemRun)) : "border-rule bg-white text-ink/52"}`}>
                  {latestProblemRun ? `문제 실행 ${runStatusLabels[latestProblemRun.status] ?? latestProblemRun.status}` : source.latestRunStatus ? `최근 ${runStatusLabels[source.latestRunStatus] ?? source.latestRunStatus}` : "실행 없음"}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <SourceStat label="요약 대기" value={source.pendingSummaryCount} />
                <SourceStat label="주의" value={source.attentionCount} />
                <SourceStat label="후보" value={candidateCount} />
              </div>
              <div className="mt-4 flex flex-wrap gap-1.5">
                <ActionLink href={adminArticlesHref(source.sourceKey, "cleaned")}>대기</ActionLink>
                <ActionLink href={adminArticlesHref(source.sourceKey, "failed_summary")}>실패요약</ActionLink>
                <ActionLink href={adminArticlesHref(source.sourceKey, "failed_fetch")}>실패수집</ActionLink>
                <ActionLink href={adminArticlesHref(source.sourceKey, "metadata_only")}>메타</ActionLink>
                <ActionLink href={adminCandidatesHref(source.sourceKey)}>후보</ActionLink>
                <ActionLink href="/admin/ingestion-runs">실행</ActionLink>
                <ActionLink href={adminAuditHref(source.sourceKey)}>감사</ActionLink>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ProblemRunList({ runs }: { runs: IngestionRunRecord[] }) {
  return (
    <section className="rounded-md border border-rule bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-court">실행 문제</p>
          <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">최근 문제 실행</h2>
        </div>
        <Link href="/admin/ingestion-runs" className="focus-ring inline-flex min-h-9 items-center gap-2 rounded-md border border-rule px-3 text-sm font-semibold text-ink/68 hover:bg-parchment">
          전체 기록
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
      {runs.length === 0 ? (
        <div className="rounded-md border border-dashed border-rule bg-parchment/35 px-4 py-8 text-center text-sm text-ink/58">
          최근 50개 실행에서 즉시 조치할 문제 실행이 없습니다.
          <div className="mt-3">
            <ActionLink href="/admin/ingestion-runs">실행 기록 보기</ActionLink>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          {runs.slice(0, 6).map((run) => {
            const uncollectedCount = uncollectedCandidateCount(run);
            return (
              <article key={`${run.sourceKey}:${run.startedAt}`} className="rounded-md border border-rule bg-parchment/25 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold tracking-normal text-ink">{displaySourceLabel(run.sourceKey)}</h3>
                    <p className="mt-1 text-xs text-ink/52">{formatDateTime(run.startedAt)} 시작</p>
                  </div>
                  <RunStatusBadge run={run} />
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink/58">
                  <span>발견 {formatNumber(run.discoveredCount)}</span>
                  <span>수집 {formatNumber(run.fetchedCount)}</span>
                  <span>요약 {formatNumber(run.summarizedCount)}</span>
                  <span className={run.failedCount > 0 ? "font-semibold text-court" : ""}>실패 {formatNumber(run.failedCount)}</span>
                  {uncollectedCount > 0 ? <span className="font-semibold text-amber-800">추적 후보 {formatNumber(uncollectedCount)}</span> : null}
                </div>
                {run.errorMessage ? <p className="mt-3 rounded-md border border-court/15 bg-white p-2 text-xs leading-5 text-court">{run.errorMessage}</p> : null}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <ActionLink href="/admin/ingestion-runs">실행 기록</ActionLink>
                  <ActionLink href={adminArticlesHref(run.sourceKey)}>기사</ActionLink>
                  <ActionLink href={adminCandidatesHref(run.sourceKey)}>후보</ActionLink>
                  <ActionLink href={adminAuditHref(run.sourceKey)}>감사</ActionLink>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function QuickLinks() {
  const links: Array<{ href: string; label: string; detail: string; icon: LucideIcon }> = [
    { href: "/admin", label: "수집·요약 실행", detail: "기존 action panel로 이동", icon: Database },
    { href: "/admin/articles", label: "기사 관리", detail: "상태별 검토와 공개 처리", icon: Newspaper },
    { href: "/admin/jobs", label: "작업 큐", detail: "대기·실패 작업과 이벤트 확인", icon: ListChecks },
    { href: "/admin/candidates", label: "URL 후보", detail: "재시도 큐와 실패 후보", icon: Link2 },
    { href: "/admin/llm", label: "LLM 관리", detail: "요약 모델과 provider 설정", icon: KeyRound },
    { href: "/admin/audit", label: "감사 로그", detail: "관리자 작업 기록 확인", icon: ShieldCheck },
  ];

  return (
    <section className="rounded-md border border-rule bg-white p-5 shadow-sm">
      <div className="mb-4">
        <p className="text-sm font-semibold text-court">빠른 작업</p>
        <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">다음 화면으로 이동</h2>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
        {links.map((item) => {
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} className="focus-ring rounded-md border border-rule bg-parchment/35 p-3 hover:bg-parchment">
              <div className="flex items-center gap-2 font-semibold text-ink">
                <Icon className="size-4 text-court" aria-hidden="true" />
                {item.label}
              </div>
              <p className="mt-1 text-xs leading-5 text-ink/56">{item.detail}</p>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export default async function AdminOperationsPage() {
  const authorized = await isAuthorizedPageRequest();

  if (!authorized) {
    redirect(`/admin/login?next=${encodeURIComponent("/admin/operations")}`);
  }

  const [dashboard, runs] = await Promise.all([getAdminDashboardData(), listIngestionRuns(50)]);
  const csrfToken = (await createAdminCsrfToken()) ?? "";
  const candidatesBySource = new Map(dashboard.candidateSummaries.map((item) => [item.sourceKey, item]));
  const problemRuns = runs.filter(isProblemRun);
  const cleanedCount = statusCount(dashboard, "cleaned");
  const failedSummaryCount = statusCount(dashboard, "failed_summary");
  const failedFetchCount = statusCount(dashboard, "failed_fetch");
  const metadataOnlyCount = statusCount(dashboard, "metadata_only");
  const needsReviewCount = statusCount(dashboard, "needs_review");
  const candidateActionTotal = dashboard.candidateSummaries.reduce((sum, item) => sum + candidateActionCount(item), 0);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-sm font-semibold text-court">관리자</p>
          <h1 className="text-3xl font-semibold tracking-normal text-ink">운영 홈</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink/66">
            지금 조치할 항목을 먼저 보고, 기사·후보·실행 기록·감사 로그로 바로 이동합니다.
          </p>
        </div>
        <form action="/api/admin/logout" method="post">
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <button type="submit" className="focus-ring inline-flex items-center gap-2 rounded-md border border-rule bg-white px-4 py-2 text-sm font-semibold text-ink/72 hover:bg-parchment">
            <LogOut className="size-4" aria-hidden="true" />
            로그아웃
          </button>
        </form>
      </div>

      <AdminTabs active="operations" />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-white px-4 py-3 text-sm text-ink/64 shadow-sm">
        <span>데이터 기준: {dashboard.hasDatabase ? "Supabase" : "Mock 데이터"}</span>
        <span>갱신 시각: {formatDateTime(dashboard.generatedAt)}</span>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <TriageMetric
          title="요약 대기"
          value={dashboard.totals.pendingSummaries}
          detail={`cleaned ${formatNumber(cleanedCount)}건, 재요약 ${formatNumber(failedSummaryCount)}건`}
          icon={Clock3}
          actions={[
            { label: "대기", href: adminArticlesHref(undefined, "cleaned") },
            { label: "실패요약", href: adminArticlesHref(undefined, "failed_summary") },
          ]}
        />
        <TriageMetric
          title="주의 항목"
          value={dashboard.totals.attentionArticles}
          detail={`검토 필요 ${formatNumber(needsReviewCount)}건, 메타 ${formatNumber(metadataOnlyCount)}건`}
          icon={AlertTriangle}
          actions={[
            { label: "검토", href: adminArticlesHref(undefined, "needs_review") },
            { label: "메타", href: adminArticlesHref(undefined, "metadata_only") },
          ]}
        />
        <TriageMetric
          title="실패 자료"
          value={dashboard.totals.failedArticles}
          detail={`요약 실패 ${formatNumber(failedSummaryCount)}건, 수집 실패 ${formatNumber(failedFetchCount)}건`}
          icon={FileWarning}
          actions={[
            { label: "요약", href: adminArticlesHref(undefined, "failed_summary") },
            { label: "수집", href: adminArticlesHref(undefined, "failed_fetch") },
          ]}
        />
        <TriageMetric
          title="URL 후보"
          value={dashboard.totals.candidates}
          detail={`pending/retrying/failed ${formatNumber(candidateActionTotal)}건`}
          icon={Link2}
          actions={[
            { label: "pending", href: adminCandidatesHref(undefined, "pending") },
            { label: "failed", href: adminCandidatesHref(undefined, "failed") },
          ]}
        />
        <TriageMetric
          title="문제 실행"
          value={problemRuns.length}
          detail="최근 50개 실행 중 failed, partial, 실패 카운트, 추적 후보 포함"
          icon={ListChecks}
          actions={[{ label: "실행 기록", href: "/admin/ingestion-runs" }]}
        />
      </section>

      <div className="mt-6 grid gap-6">
        <SourceActionCards sources={dashboard.sourceSummaries} candidatesBySource={candidatesBySource} problemRuns={problemRuns} />
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.75fr)]">
          <ProblemRunList runs={problemRuns} />
          <QuickLinks />
        </div>
      </div>
    </main>
  );
}
