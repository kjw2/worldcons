import Link from "next/link";
import { AlertTriangle, ArrowRight, Clock3, Database, FileWarning, Radio, Send, ShieldCheck } from "lucide-react";
import type { AdminOperationsOverviewSnapshot } from "@/lib/admin/p4/overview";
import { adminStateText } from "@/lib/admin/p4/labels";
import { displaySourceLabel } from "@/lib/ui/source-labels";

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatDateTime(value?: string | null) {
  if (!value) return "기록 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "기록 없음";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Seoul" }).format(date);
}

function Metric({ label, value, href, tone = "neutral" }: { label: string; value: number; href: string; tone?: "neutral" | "warning" | "danger" }) {
  return (
    <Link href={href} className={`focus-ring block rounded-md border bg-white px-4 py-3 hover:bg-parchment ${tone === "danger" ? "border-court/30" : tone === "warning" ? "border-amber-300" : "border-rule"}`}>
      <span className="block text-xs font-semibold text-ink/52">{label}</span>
      <span className={tone === "danger" ? "mt-1 block text-2xl font-semibold text-court" : "mt-1 block text-2xl font-semibold text-ink"}>{formatNumber(value)}</span>
    </Link>
  );
}

function Stage({ label, detail, value, href, icon: Icon }: { label: string; detail: string; value: number; href: string; icon: typeof Database }) {
  return (
    <Link href={href} className="focus-ring group grid min-h-28 grid-cols-[36px_minmax(0,1fr)_auto] items-start gap-3 border-b border-rule px-4 py-4 last:border-b-0 hover:bg-parchment/60 sm:px-5 lg:border-b-0 lg:border-r lg:last:border-r-0">
      <span className="inline-flex size-9 items-center justify-center rounded-md border border-rule bg-white text-court"><Icon className="size-4" aria-hidden="true" /></span>
      <span className="min-w-0"><span className="block font-semibold text-ink">{label}</span><span className="mt-1 block text-xs leading-5 text-ink/52">{detail}</span></span>
      <span className="flex items-center gap-2 text-lg font-semibold text-ink"><span>{formatNumber(value)}</span><ArrowRight className="size-4 text-ink/35 group-hover:text-court" aria-hidden="true" /></span>
    </Link>
  );
}

export function AdminOperationsOverview({ snapshot }: { snapshot: AdminOperationsOverviewSnapshot }) {
  const { dashboard, work } = snapshot;
  const candidateAttention = dashboard.candidateSummaries.reduce((sum, item) => sum + item.pendingCount + item.retryingCount + item.failedCount, 0);
  const reviewAttention = dashboard.totals.attentionArticles;
  return (
    <div className="min-w-0 py-6">
      <header className="px-4 pb-5 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase text-court">운영 BPM</p>
            <h1 className="mt-1 text-2xl font-semibold text-ink">운영 개요</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/60">현재 업무 흐름, 수집원 상태, 처리 기한과 조치가 필요한 업무를 한눈에 확인합니다.</p>
          </div>
          <div className="text-right text-xs text-ink/48"><p>{dashboard.hasDatabase ? "데이터베이스 기준" : "호환 데이터 기준"}</p><p className="mt-1">{formatDateTime(snapshot.generatedAt)}</p></div>
        </div>
      </header>

      {work.compatibilityMode ? (
        <div className="border-y border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:px-6" role="status">
          <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" aria-hidden="true" />호환 데이터 사용 중</div>
          <p className="mt-1">이전 작업 기록은 통합 업무 큐에서 계속 확인할 수 있으며, 폐기된 관리자 화면은 더 이상 노출되지 않습니다.</p>
        </div>
      ) : null}

      <section className="border-b border-rule bg-white" aria-labelledby="bpm-flow">
        <h2 id="bpm-flow" className="sr-only">운영 단계</h2>
        <div className="grid lg:grid-cols-4">
          <Stage label="수집" detail="수집원 확인 및 URL 후보 처리" value={candidateAttention} href="/admin/work?stage=collect&attention=required" icon={Database} />
          <Stage label="처리 / 요약" detail="대기·실행·실패·지연 상태 확인" value={dashboard.totals.pendingSummaries} href="/admin/work?stage=process&attention=required" icon={Clock3} />
          <Stage label="검토" detail="공개와 분리된 사람의 검토 단계" value={reviewAttention} href="/admin/work?stage=review&attention=required" icon={ShieldCheck} />
          <Stage label="공개" detail="명시적 공개 결정 및 캐시 전달 상태" value={work.counts.outbox} href="/admin/work?stage=publish&attention=required" icon={Send} />
        </div>
      </section>

      <section className="px-4 py-5 sm:px-6" aria-labelledby="attention-signals">
        <div className="mb-3 flex items-center gap-2"><Radio className="size-4 text-court" aria-hidden="true" /><h2 id="attention-signals" className="text-base font-semibold text-ink">주의 신호</h2></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <Metric label="처리 대기" value={work.counts.backlog} href="/admin/work?attention=required" />
          <Metric label="기한 초과" value={work.counts.breached} href="/admin/work?attention=required&sla=breached&sort=sla" tone="danger" />
          <Metric label="실패" value={work.counts.failed} href="/admin/work?attention=required&state=failed" tone="danger" />
          <Metric label="장기 지연" value={work.counts.stale} href="/admin/work?attention=required&state=stale" tone="warning" />
          <Metric label="중단 요청" value={work.counts.abortRequested} href="/admin/work?type=execution&state=abort" tone="warning" />
          <Metric label="전달 대기" value={work.counts.outbox} href="/admin/work?type=outbox&attention=required" tone="warning" />
        </div>
      </section>

      <section className="border-y border-rule bg-white" aria-labelledby="source-health">
        <div className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6"><div><p className="text-xs font-semibold uppercase text-court">수집원</p><h2 id="source-health" className="mt-1 text-base font-semibold text-ink">상태 및 업무 부담</h2></div><Link href="/admin/work?stage=collect" className="focus-ring inline-flex min-h-9 items-center gap-2 rounded-md border border-rule px-3 text-sm font-semibold text-ink/65 hover:bg-parchment">전체 수집 업무<ArrowRight className="size-4" aria-hidden="true" /></Link></div>
        <div className="grid divide-y divide-rule md:hidden">
          {dashboard.sourceSummaries.map((source) => <Link key={source.sourceKey} href={`/admin/work?source=${encodeURIComponent(source.sourceKey)}`} className="focus-ring grid gap-2 px-4 py-3 hover:bg-parchment"><span className="font-semibold text-ink">{displaySourceLabel(source)}</span><span className="text-xs text-ink/55">{source.sourceKey} · 처리 대기 {formatNumber(source.pendingSummaryCount)} · 주의 {formatNumber(source.attentionCount)} · 실패 {formatNumber(source.failedCount)}</span></Link>)}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-[900px] table-fixed divide-y divide-rule text-sm"><thead className="bg-parchment"><tr className="text-left text-xs font-semibold text-ink/58"><th className="w-[260px] px-4 py-3">수집원</th><th className="px-4 py-3">기사</th><th className="px-4 py-3">처리 대기</th><th className="px-4 py-3">주의</th><th className="px-4 py-3">실패</th><th className="w-[180px] px-4 py-3">최근 실행</th></tr></thead><tbody className="divide-y divide-rule">{dashboard.sourceSummaries.map((source) => <tr key={source.sourceKey} className="hover:bg-parchment/30"><td className="px-4 py-3"><Link href={`/admin/work?source=${encodeURIComponent(source.sourceKey)}`} className="focus-ring rounded-sm font-semibold text-ink hover:text-court">{displaySourceLabel(source)}</Link><div className="mt-1 text-xs text-ink/45">{source.sourceKey}</div></td><td className="px-4 py-3">{formatNumber(source.totalCount)}</td><td className="px-4 py-3">{formatNumber(source.pendingSummaryCount)}</td><td className="px-4 py-3">{formatNumber(source.attentionCount)}</td><td className="px-4 py-3 text-court">{formatNumber(source.failedCount)}</td><td className="px-4 py-3 text-xs text-ink/55"><div className="font-semibold text-ink/70">{source.latestRunStatus ? adminStateText(source.latestRunStatus) : "실행 기록 없음"}</div><div className="mt-1">{formatDateTime(source.latestRunStartedAt)}</div></td></tr>)}</tbody></table>
        </div>
      </section>

      <section className="px-4 py-5 sm:px-6" aria-labelledby="latest-runs">
        <div className="mb-3 flex items-center gap-2"><FileWarning className="size-4 text-court" aria-hidden="true" /><h2 id="latest-runs" className="text-base font-semibold text-ink">최근 수집 실행</h2></div>
        {dashboard.latestRuns.length === 0 ? <div className="border-y border-dashed border-rule py-10 text-center text-sm text-ink/55">수집 실행 기록이 없습니다.</div> : <div className="grid divide-y divide-rule border-y border-rule bg-white">{dashboard.latestRuns.slice(0, 8).map((run) => <Link key={run.id} href="/admin/ingestion-runs" className="focus-ring grid gap-2 px-4 py-3 hover:bg-parchment sm:grid-cols-[minmax(180px,1fr)_140px_180px_160px]"><span className="break-all font-semibold text-ink">{run.sourceKey}</span><span className={run.status === "failed" ? "font-semibold text-court" : "text-ink/65"}>{adminStateText(run.status)}</span><span className="text-xs text-ink/52">{formatDateTime(run.startedAt)}</span><span className="text-xs text-ink/52">수집 {formatNumber(run.fetchedCount)} · 실패 {formatNumber(run.failedCount)}</span></Link>)}</div>}
      </section>

      <section className="border-t border-rule bg-white px-4 py-5 sm:px-6" aria-labelledby="state-domains">
        <h2 id="state-domains" className="text-base font-semibold text-ink">업무 권한 영역은 서로 독립적입니다</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-3"><div className="border-l-2 border-primary pl-3"><p className="font-semibold text-ink">큐 실행</p><p className="mt-1 text-xs leading-5 text-ink/55">명령, 실행, 시도, 임대, 펜싱, 중단 및 재시도.</p></div><div className="border-l-2 border-amber-500 pl-3"><p className="font-semibold text-ink">기사 처리 단계</p><p className="mt-1 text-xs leading-5 text-ink/55">수집, 처리, 검토 및 구조화된 주의 상태.</p></div><div className="border-l-2 border-mint pl-3"><p className="font-semibold text-ink">공개</p><p className="mt-1 text-xs leading-5 text-ink/55">변경 불가 버전, 명시적 결정, 감사 및 캐시 전달.</p></div></div>
      </section>
    </div>
  );
}
