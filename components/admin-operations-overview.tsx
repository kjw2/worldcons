import Link from "next/link";
import { AlertTriangle, ArrowRight, Clock3, Database, FileWarning, Radio, Send, ShieldCheck } from "lucide-react";
import type { AdminOperationsOverviewSnapshot } from "@/lib/admin/p4/overview";
import { displaySourceLabel } from "@/lib/ui/source-labels";

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatDateTime(value?: string | null) {
  if (!value) return "No record";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No record";
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
            <p className="text-xs font-semibold uppercase text-court">Operational BPM</p>
            <h1 className="mt-1 text-2xl font-semibold text-ink">Operations overview</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/60">Current flow, source health, SLA pressure, and safe routes into filtered work.</p>
          </div>
          <div className="text-right text-xs text-ink/48"><p>{dashboard.hasDatabase ? "Database snapshot" : "Compatibility data"}</p><p className="mt-1">{formatDateTime(snapshot.generatedAt)}</p></div>
        </div>
      </header>

      {work.compatibilityMode ? (
        <div className="border-y border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:px-6" role="status">
          <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" aria-hidden="true" />Compatibility data is active</div>
          <p className="mt-1">Earlier job records remain available inside the unified queue. Retired administrator screens are no longer exposed.</p>
        </div>
      ) : null}

      <section className="border-b border-rule bg-white" aria-labelledby="bpm-flow">
        <h2 id="bpm-flow" className="sr-only">Operational stages</h2>
        <div className="grid lg:grid-cols-4">
          <Stage label="Collect" detail="Source acquisition and URL candidates" value={candidateAttention} href="/admin/work?stage=collect&attention=required" icon={Database} />
          <Stage label="Process / summarize" detail="Ready, running, failed, or stale processing" value={dashboard.totals.pendingSummaries} href="/admin/work?stage=process&attention=required" icon={Clock3} />
          <Stage label="Review" detail="Human lifecycle attention, separate from publication" value={reviewAttention} href="/admin/work?stage=review&attention=required" icon={ShieldCheck} />
          <Stage label="Publish" detail="Explicit publication and cache outbox state" value={work.counts.outbox} href="/admin/work?stage=publish&attention=required" icon={Send} />
        </div>
      </section>

      <section className="px-4 py-5 sm:px-6" aria-labelledby="attention-signals">
        <div className="mb-3 flex items-center gap-2"><Radio className="size-4 text-court" aria-hidden="true" /><h2 id="attention-signals" className="text-base font-semibold text-ink">Attention signals</h2></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <Metric label="Backlog" value={work.counts.backlog} href="/admin/work?attention=required" />
          <Metric label="SLA breached" value={work.counts.breached} href="/admin/work?attention=required&sla=breached&sort=sla" tone="danger" />
          <Metric label="Failed" value={work.counts.failed} href="/admin/work?attention=required&state=failed" tone="danger" />
          <Metric label="Stale" value={work.counts.stale} href="/admin/work?attention=required&state=stale" tone="warning" />
          <Metric label="Abort" value={work.counts.abortRequested} href="/admin/work?type=execution&state=abort" tone="warning" />
          <Metric label="Outbox" value={work.counts.outbox} href="/admin/work?type=outbox&attention=required" tone="warning" />
        </div>
      </section>

      <section className="border-y border-rule bg-white" aria-labelledby="source-health">
        <div className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6"><div><p className="text-xs font-semibold uppercase text-court">Sources</p><h2 id="source-health" className="mt-1 text-base font-semibold text-ink">Health and work pressure</h2></div><Link href="/admin/work?stage=collect" className="focus-ring inline-flex min-h-9 items-center gap-2 rounded-md border border-rule px-3 text-sm font-semibold text-ink/65 hover:bg-parchment">All collection work<ArrowRight className="size-4" aria-hidden="true" /></Link></div>
        <div className="grid divide-y divide-rule md:hidden">
          {dashboard.sourceSummaries.map((source) => <Link key={source.sourceKey} href={`/admin/work?source=${encodeURIComponent(source.sourceKey)}`} className="focus-ring grid gap-2 px-4 py-3 hover:bg-parchment"><span className="font-semibold text-ink">{displaySourceLabel(source)}</span><span className="text-xs text-ink/55">{source.sourceKey} · pending {formatNumber(source.pendingSummaryCount)} · attention {formatNumber(source.attentionCount)} · failed {formatNumber(source.failedCount)}</span></Link>)}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-[900px] table-fixed divide-y divide-rule text-sm"><thead className="bg-parchment"><tr className="text-left text-xs font-semibold text-ink/58"><th className="w-[260px] px-4 py-3">Source</th><th className="px-4 py-3">Articles</th><th className="px-4 py-3">Process backlog</th><th className="px-4 py-3">Attention</th><th className="px-4 py-3">Failed</th><th className="w-[180px] px-4 py-3">Latest run</th></tr></thead><tbody className="divide-y divide-rule">{dashboard.sourceSummaries.map((source) => <tr key={source.sourceKey} className="hover:bg-parchment/30"><td className="px-4 py-3"><Link href={`/admin/work?source=${encodeURIComponent(source.sourceKey)}`} className="focus-ring rounded-sm font-semibold text-ink hover:text-court">{displaySourceLabel(source)}</Link><div className="mt-1 text-xs text-ink/45">{source.sourceKey}</div></td><td className="px-4 py-3">{formatNumber(source.totalCount)}</td><td className="px-4 py-3">{formatNumber(source.pendingSummaryCount)}</td><td className="px-4 py-3">{formatNumber(source.attentionCount)}</td><td className="px-4 py-3 text-court">{formatNumber(source.failedCount)}</td><td className="px-4 py-3 text-xs text-ink/55"><div className="font-semibold text-ink/70">{source.latestRunStatus ?? "No run"}</div><div className="mt-1">{formatDateTime(source.latestRunStartedAt)}</div></td></tr>)}</tbody></table>
        </div>
      </section>

      <section className="px-4 py-5 sm:px-6" aria-labelledby="latest-runs">
        <div className="mb-3 flex items-center gap-2"><FileWarning className="size-4 text-court" aria-hidden="true" /><h2 id="latest-runs" className="text-base font-semibold text-ink">Latest ingestion runs</h2></div>
        {dashboard.latestRuns.length === 0 ? <div className="border-y border-dashed border-rule py-10 text-center text-sm text-ink/55">No ingestion runs are available.</div> : <div className="grid divide-y divide-rule border-y border-rule bg-white">{dashboard.latestRuns.slice(0, 8).map((run) => <Link key={run.id} href="/admin/ingestion-runs" className="focus-ring grid gap-2 px-4 py-3 hover:bg-parchment sm:grid-cols-[minmax(180px,1fr)_140px_180px_160px]"><span className="break-all font-semibold text-ink">{run.sourceKey}</span><span className={run.status === "failed" ? "font-semibold text-court" : "text-ink/65"}>{run.status}</span><span className="text-xs text-ink/52">{formatDateTime(run.startedAt)}</span><span className="text-xs text-ink/52">fetched {formatNumber(run.fetchedCount)} · failed {formatNumber(run.failedCount)}</span></Link>)}</div>}
      </section>

      <section className="border-t border-rule bg-white px-4 py-5 sm:px-6" aria-labelledby="state-domains">
        <h2 id="state-domains" className="text-base font-semibold text-ink">Authority domains remain independent</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-3"><div className="border-l-2 border-primary pl-3"><p className="font-semibold text-ink">Queue execution</p><p className="mt-1 text-xs leading-5 text-ink/55">Commands, runs, attempts, leases, fences, abort, retry.</p></div><div className="border-l-2 border-amber-500 pl-3"><p className="font-semibold text-ink">Article lifecycle</p><p className="mt-1 text-xs leading-5 text-ink/55">Collection, processing, review, and structured attention.</p></div><div className="border-l-2 border-mint pl-3"><p className="font-semibold text-ink">Publication</p><p className="mt-1 text-xs leading-5 text-ink/55">Immutable versions, explicit decisions, audit, and outbox.</p></div></div>
      </section>
    </div>
  );
}
