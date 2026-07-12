import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Clock3,
  Database,
  FileWarning,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { AdminActionPanel } from "@/components/admin-action-panel";
import { AdminAttentionTable } from "@/components/admin-attention-table";
import { AdminOperationsOverview } from "@/components/admin-operations-overview";
import { AdminTabs } from "@/components/admin-tabs";
import { adminRedesignUiEnabled } from "@/lib/admin/p4/flags";
import { getAdminOperationsOverviewSnapshot } from "@/lib/admin/p4/overview";
import { getAdminDashboardData, type AdminStatusCount } from "@/lib/db/admin-queries";
import { displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";
import { createAdminCsrfToken, isAuthorizedPageRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const statusLabels: Record<string, string> = {
  discovered: "발견",
  metadata_only: "메타만 있음",
  robots_disallowed: "robots 제한",
  blocked: "접근 차단",
  timeout: "시간 초과",
  fetched: "수집됨",
  cleaned: "요약 대기",
  summarizing: "요약 중",
  summarized: "공개",
  failed_fetch: "수집 실패",
  failed_summary: "요약 실패",
  needs_review: "검토 필요",
};

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

function adminArticlesHref(sourceKey: string, status?: string) {
  const statusQuery = status ? `&status=${encodeURIComponent(status)}` : "";
  return `/admin/articles?sourceKey=${encodeURIComponent(sourceKey)}${statusQuery}`;
}

function adminCandidatesHref(sourceKey: string) {
  return `/admin/candidates?source=${encodeURIComponent(sourceKey)}`;
}

function adminAuditHref(sourceKey: string) {
  return `/admin/audit?q=${encodeURIComponent(sourceKey)}`;
}

function statusClass(status: string) {
  if (status === "summarized" || status === "completed") return "border-mint/25 bg-mint/10 text-mint";
  if (status === "cleaned" || status === "summarizing" || status === "running") return "border-ink/15 bg-parchment text-ink/72";
  if (status === "needs_review" || status === "metadata_only") return "border-amber-400/40 bg-amber-50 text-amber-800";
  if (status.includes("failed") || status === "blocked" || status === "timeout" || status === "robots_disallowed") {
    return "border-court/25 bg-court/5 text-court";
  }
  return "border-rule bg-white text-ink/64";
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold ${statusClass(status)}`}>
      {statusLabels[status] ?? status}
    </span>
  );
}

function OperationLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className="focus-ring inline-flex min-h-8 items-center rounded-md border border-rule px-2.5 text-xs font-semibold text-ink/68 hover:bg-parchment">
      {children}
    </Link>
  );
}

function MetricCard({
  title,
  value,
  detail,
  icon: Icon,
}: {
  title: string;
  value: string;
  detail: string;
  icon: LucideIcon;
}) {
  return (
    <section className="rounded-md border border-rule bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-ink/64">{title}</span>
        <span className="inline-flex size-9 items-center justify-center rounded-md border border-rule bg-parchment text-court">
          <Icon className="size-4" aria-hidden="true" />
        </span>
      </div>
      <div className="text-3xl font-semibold tracking-normal text-ink">{value}</div>
      <p className="mt-2 text-sm leading-5 text-ink/62">{detail}</p>
    </section>
  );
}

function StatusCountGrid({ counts }: { counts: AdminStatusCount[] }) {
  return (
    <section className="rounded-md border border-rule bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-court">상태 분포</p>
          <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">자료 처리 단계</h2>
        </div>
        <BarChart3 className="size-5 text-ink/50" aria-hidden="true" />
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {counts.map((item) => (
          <div key={item.status} className="flex min-h-12 items-center justify-between gap-3 rounded-md border border-rule bg-parchment/45 px-3">
            <StatusBadge status={item.status} />
            <span className="text-sm font-semibold text-ink">{formatNumber(item.count)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SourceTable({ data }: { data: Awaited<ReturnType<typeof getAdminDashboardData>>["sourceSummaries"] }) {
  return (
    <section className="rounded-md border border-rule bg-white shadow-sm">
      <div className="border-b border-rule p-5">
        <p className="text-sm font-semibold text-court">수집원</p>
        <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">기관별 처리 현황</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-rule text-sm">
          <thead className="bg-parchment">
            <tr className="text-left text-xs font-semibold uppercase text-ink/60">
              <th className="px-4 py-3">기관</th>
              <th className="px-4 py-3">공개율</th>
              <th className="px-4 py-3">전체</th>
              <th className="px-4 py-3">공개</th>
              <th className="px-4 py-3">요약 대기</th>
              <th className="px-4 py-3">주의</th>
              <th className="px-4 py-3">최근 실행</th>
              <th className="px-4 py-3">최근 수집</th>
              <th className="px-4 py-3">관리</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {data.map((source) => {
              const publicRate = source.totalCount > 0 ? Math.round((source.publicCount / source.totalCount) * 100) : 0;
              return (
                <tr key={source.sourceKey}>
                  <td className="px-4 py-3">
                    <Link href={adminArticlesHref(source.sourceKey)} className="focus-ring rounded-sm font-semibold text-ink hover:text-court">
                      {displaySourceLabel({ sourceKey: source.sourceKey, name: source.name })}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink/56">
                      <span>{source.sourceKey}</span>
                      <span>{displayJurisdictionLabel(source.jurisdiction)}</span>
                      <span>{source.language}</span>
                      <span>{source.isActive ? "active" : "inactive"}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex min-w-32 items-center gap-3">
                      <div className="h-2 flex-1 rounded-full bg-rule">
                        <div className="h-2 rounded-full bg-mint" style={{ width: `${publicRate}%` }} />
                      </div>
                      <span className="w-10 text-right text-xs font-semibold text-ink/64">{publicRate}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-semibold">{formatNumber(source.totalCount)}</td>
                  <td className="px-4 py-3">{formatNumber(source.publicCount)}</td>
                  <td className="px-4 py-3">{formatNumber(source.pendingSummaryCount)}</td>
                  <td className="px-4 py-3">{formatNumber(source.attentionCount)}</td>
                  <td className="px-4 py-3">
                    {source.latestRunStatus ? <StatusBadge status={source.latestRunStatus} /> : <span className="text-ink/45">없음</span>}
                    <div className="mt-1 text-xs text-ink/50">{formatDateTime(source.latestRunStartedAt)}</div>
                  </td>
                  <td className="px-4 py-3">{formatDateTime(source.latestFetchedAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <OperationLink href={adminArticlesHref(source.sourceKey)}>기사</OperationLink>
                      <OperationLink href={adminArticlesHref(source.sourceKey, "cleaned")}>대기</OperationLink>
                      <OperationLink href={adminArticlesHref(source.sourceKey, "failed_summary")}>실패요약</OperationLink>
                      <OperationLink href={adminArticlesHref(source.sourceKey, "failed_fetch")}>실패수집</OperationLink>
                      <OperationLink href={adminArticlesHref(source.sourceKey, "metadata_only")}>메타</OperationLink>
                      <OperationLink href={adminCandidatesHref(source.sourceKey)}>후보</OperationLink>
                      <OperationLink href={adminAuditHref(source.sourceKey)}>감사</OperationLink>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CandidateTable({ data }: { data: Awaited<ReturnType<typeof getAdminDashboardData>>["candidateSummaries"] }) {
  return (
    <section className="rounded-md border border-rule bg-white shadow-sm">
      <div className="border-b border-rule p-5">
        <p className="text-sm font-semibold text-court">URL 후보</p>
        <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">재시도 큐</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-rule text-sm">
          <thead className="bg-parchment">
            <tr className="text-left text-xs font-semibold uppercase text-ink/60">
              <th className="px-4 py-3">source_key</th>
              <th className="px-4 py-3">pending</th>
              <th className="px-4 py-3">retrying</th>
              <th className="px-4 py-3">fetched</th>
              <th className="px-4 py-3">failed</th>
              <th className="px-4 py-3">ignored</th>
              <th className="px-4 py-3">최근 후보</th>
              <th className="px-4 py-3">관리</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {data.map((item) => (
              <tr key={item.sourceKey}>
                <td className="px-4 py-3">
                  <Link href={`/admin/candidates?source=${encodeURIComponent(item.sourceKey)}`} className="focus-ring rounded-sm font-semibold text-ink hover:text-court">
                    {displaySourceLabel(item.sourceKey)}
                  </Link>
                  <div className="mt-1 text-xs text-ink/54">{item.sourceKey}</div>
                </td>
                <td className="px-4 py-3"><Link href={`/admin/candidates?source=${encodeURIComponent(item.sourceKey)}&status=pending`} className="focus-ring rounded-sm text-ink hover:text-court">{formatNumber(item.pendingCount)}</Link></td>
                <td className="px-4 py-3"><Link href={`/admin/candidates?source=${encodeURIComponent(item.sourceKey)}&status=retrying`} className="focus-ring rounded-sm text-ink hover:text-court">{formatNumber(item.retryingCount)}</Link></td>
                <td className="px-4 py-3"><Link href={`/admin/candidates?source=${encodeURIComponent(item.sourceKey)}&status=fetched`} className="focus-ring rounded-sm text-ink hover:text-court">{formatNumber(item.fetchedCount)}</Link></td>
                <td className="px-4 py-3 text-court"><Link href={`/admin/candidates?source=${encodeURIComponent(item.sourceKey)}&status=failed`} className="focus-ring rounded-sm text-court hover:underline">{formatNumber(item.failedCount)}</Link></td>
                <td className="px-4 py-3"><Link href={`/admin/candidates?source=${encodeURIComponent(item.sourceKey)}&status=ignored`} className="focus-ring rounded-sm text-ink hover:text-court">{formatNumber(item.ignoredCount)}</Link></td>
                <td className="px-4 py-3">{formatDateTime(item.latestCreatedAt)}</td>
                <td className="px-4 py-3">
                  <Link href={`/admin/candidates?source=${encodeURIComponent(item.sourceKey)}`} className="focus-ring inline-flex min-h-8 items-center rounded-md border border-rule px-2.5 text-xs font-semibold text-ink/68 hover:bg-parchment">
                    후보 보기
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function AdminPage() {
  const authorized = await isAuthorizedPageRequest();

  if (!authorized) {
    redirect(`/admin/login?next=${encodeURIComponent("/admin")}`);
  }

  if (adminRedesignUiEnabled()) {
    return <AdminOperationsOverview snapshot={await getAdminOperationsOverviewSnapshot()} />;
  }

  const dashboard = await getAdminDashboardData();
  const csrfToken = (await createAdminCsrfToken()) ?? "";
  const sources = dashboard.sourceSummaries.map((source) => ({
    sourceKey: source.sourceKey,
    name: source.name,
    jurisdiction: source.jurisdiction,
    baseUrl: source.baseUrl,
    language: source.language,
    isActive: source.isActive,
  }));

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-sm font-semibold text-court">관리자</p>
          <h1 className="text-3xl font-semibold tracking-normal text-ink">운영 대시보드</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink/66">
            수집 상태, 공개 가능 자료, 요약 대기열, 실패 항목을 확인합니다. 상세 실행 기록은 별도 화면에서 봅니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/" className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink/90">
            공개 화면
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
          <form action="/api/admin/logout" method="post">
            <input type="hidden" name="csrfToken" value={csrfToken} />
            <button type="submit" className="focus-ring inline-flex items-center gap-2 rounded-md border border-rule bg-white px-4 py-2 text-sm font-semibold text-ink/72 hover:bg-parchment">
              <LogOut className="size-4" aria-hidden="true" />
              로그아웃
            </button>
          </form>
        </div>
      </div>

      <AdminTabs active="dashboard" />

      <div className="mb-6 rounded-md border border-rule bg-white px-4 py-3 text-sm text-ink/64 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>데이터 기준: {dashboard.hasDatabase ? "Supabase" : "Mock 데이터"}</span>
          <span>갱신 시각: {formatDateTime(dashboard.generatedAt)}</span>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="전체 자료" value={formatNumber(dashboard.totals.articles)} detail={`${formatNumber(dashboard.totals.sources)}개 수집원에서 보관 중`} icon={Database} />
        <MetricCard title="공개 자료" value={formatNumber(dashboard.totals.publicArticles)} detail="요약 완료 및 publishable=true" icon={CheckCircle2} />
        <MetricCard title="요약 대기" value={formatNumber(dashboard.totals.pendingSummaries)} detail="cleaned 또는 재요약 대상" icon={Clock3} />
        <MetricCard title="주의 항목" value={formatNumber(dashboard.totals.attentionArticles)} detail={`${formatNumber(dashboard.totals.failedArticles)}개 실패 포함`} icon={FileWarning} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <AdminActionPanel sources={sources} csrfToken={csrfToken} />
        <section className="rounded-md border border-rule bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-court">빠른 점검</p>
              <h2 className="mt-1 text-xl font-semibold tracking-normal text-ink">운영 신호</h2>
            </div>
            <AlertTriangle className="size-5 text-court" aria-hidden="true" />
          </div>
          <div className="grid gap-3">
            <div className="flex items-center justify-between rounded-md border border-rule bg-parchment/45 px-3 py-3 text-sm">
              <span className="font-medium text-ink/70">태그</span>
              <span className="font-semibold text-ink">{formatNumber(dashboard.totals.tags)}</span>
            </div>
            <div className="flex items-center justify-between rounded-md border border-rule bg-parchment/45 px-3 py-3 text-sm">
              <span className="font-medium text-ink/70">URL 후보</span>
              <Link href="/admin/candidates" className="focus-ring rounded-sm font-semibold text-ink hover:text-court">{formatNumber(dashboard.totals.candidates)}</Link>
            </div>
            <div className="flex items-center justify-between rounded-md border border-rule bg-parchment/45 px-3 py-3 text-sm">
              <span className="font-medium text-ink/70">실패 자료</span>
              <Link href="/admin/articles" className="focus-ring rounded-sm font-semibold text-court hover:underline">{formatNumber(dashboard.totals.failedArticles)}</Link>
            </div>
          </div>
        </section>
      </div>

      <div className="mt-6 grid gap-6">
        <SourceTable data={dashboard.sourceSummaries} />
        <div className="grid gap-6 xl:grid-cols-2">
          <StatusCountGrid counts={dashboard.statusCounts} />
          <CandidateTable data={dashboard.candidateSummaries} />
        </div>
        <AdminAttentionTable data={dashboard.attentionArticles} csrfToken={csrfToken} />
      </div>
    </main>
  );
}
