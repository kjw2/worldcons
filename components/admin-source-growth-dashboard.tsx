import Link from "next/link";
import { Activity, ArrowRight, Database, TrendingDown, TrendingUp } from "lucide-react";
import type { SourceGrowthRow, SourceGrowthSnapshot } from "@/lib/admin/source-growth";
import { displaySourceLabel } from "@/lib/ui/source-labels";

const count = (value: number) => new Intl.NumberFormat("ko-KR").format(value);

function changeText(recent: number, previous: number) {
  const difference = recent - previous;
  if (difference === 0) return "이전 같은 기간과 동일";
  if (previous === 0) return recent > 0 ? "직전 기간 0건 · 신규 증가" : "이전 같은 기간과 동일";
  const percent = Math.round((difference / previous) * 100);
  return `직전 동기간 대비 ${percent > 0 ? "+" : ""}${percent}%`;
}

function PeriodMetric({ label, recent, previous }: { label: string; recent: number; previous: number }) {
  const delta = recent - previous;
  return (
    <div className="rounded-lg border border-rule bg-parchment/30 p-3">
      <p className="text-xs font-semibold text-ink/55">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">+{count(recent)}<span className="ml-1 text-xs font-medium text-ink/55">건</span></p>
      <p className={`mt-1 flex items-center gap-1 text-xs ${delta > 0 ? "text-mint" : delta < 0 ? "text-court" : "text-ink/50"}`}>
        {delta > 0 ? <TrendingUp className="size-3.5" aria-hidden="true" /> : delta < 0 ? <TrendingDown className="size-3.5" aria-hidden="true" /> : null}
        {changeText(recent, previous)}
      </p>
    </div>
  );
}

function DailyBars({ source }: { source: SourceGrowthRow }) {
  const peak = Math.max(1, ...source.days.map(({ count: value }) => value));
  const first = source.days[0]?.date.slice(5).replace("-", "/") ?? "";
  const last = source.days.at(-1)?.date.slice(5).replace("-", "/") ?? "";
  return (
    <div>
      <div className="mb-3 flex items-center justify-between text-xs text-ink/55">
        <span>최근 30일 신규 등록 추이</span>
        <span>최다 {count(peak === 1 && source.days.every((day) => day.count === 0) ? 0 : peak)}건/일</span>
      </div>
      <div
        role="img"
        aria-label={`${displaySourceLabel(source.sourceKey)} 최근 30일 신규 등록: ${source.days.map((day) => `${day.date} ${day.count}건`).join(", ")}`}
        className="grid h-24 items-end gap-1 border-b border-rule pb-1"
        style={{ gridTemplateColumns: "repeat(30, minmax(0, 1fr))" }}
      >
        {source.days.map((day) => (
          <span
            key={day.date}
            title={`${day.date}: ${count(day.count)}건`}
            className={`block min-w-0 rounded-t-sm ${day.count > 0 ? "bg-court/75" : "bg-ink/10"}`}
            style={{ height: day.count > 0 ? `${Math.max(8, (day.count / peak) * 100)}%` : "3px" }}
            aria-hidden="true"
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between text-xs tabular-nums text-ink/40">
        <span>{first}</span><span>{last}</span>
      </div>
    </div>
  );
}

function SourceCard({ source }: { source: SourceGrowthRow }) {
  return (
    <article className="rounded-xl border border-rule bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-ink">{displaySourceLabel(source.sourceKey)}</h3>
          <p className="mt-1 text-xs text-ink/45">{source.sourceKey}</p>
        </div>
        <Link className="focus-ring inline-flex items-center gap-1 rounded-md border border-rule px-3 py-2 text-xs font-semibold text-ink/65 hover:bg-parchment" href={`/admin/articles?sourceKey=${encodeURIComponent(source.sourceKey)}`}>
          기사 보기 <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
      <div className="mb-4 flex items-end gap-2">
        <span className="text-sm font-medium text-ink/55">누적 등록 기사</span>
        <strong className="ml-auto text-3xl font-semibold tabular-nums text-ink">{count(source.total)}</strong>
        <span className="pb-1 text-xs text-ink/55">건</span>
      </div>
      <div className="mb-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <PeriodMetric label="오늘 (1일)" recent={source.recent1d} previous={source.previous1d} />
        <PeriodMetric label="최근 7일" recent={source.recent7d} previous={source.previous7d} />
        <PeriodMetric label="최근 30일" recent={source.recent30d} previous={source.previous30d} />
      </div>
      <DailyBars source={source} />
    </article>
  );
}

export function AdminSourceGrowthDashboard({ snapshot }: { snapshot: SourceGrowthSnapshot }) {
  const time = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short",
  }).format(new Date(snapshot.generatedAt));
  return (
    <div className="min-w-0 px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase text-court">WorldCons</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink">대시보드</h1>
          <p className="mt-2 text-sm leading-6 text-ink/60">수집원별 누적 등록 기사와 1일·7일·30일 신규 증가 추이를 확인합니다.</p>
        </div>
        <p className="text-xs text-ink/50">한국시간 {time} 기준</p>
      </header>

      {!snapshot.available ? (
        <section className="rounded-xl border border-court/30 bg-white p-6" role="alert">
          <h2 className="font-semibold text-court">수집 통계 확인 불가</h2>
          <p className="mt-2 text-sm text-ink/70">{snapshot.reason} 실제 0건으로 표시하지 않습니다.</p>
        </section>
      ) : (
        <>
          <section className="mb-8" aria-labelledby="total-counts">
            <div className="mb-3 flex items-center gap-2">
              <Database className="size-4 text-court" aria-hidden="true" />
              <h2 id="total-counts" className="text-base font-semibold text-ink">전체 수집 현황</h2>
              <span className="text-xs text-ink/50">수집원 {snapshot.sources.length}개</span>
            </div>
            <div className="grid gap-3 rounded-xl border border-rule bg-white p-4 sm:grid-cols-4">
              <div className="rounded-lg bg-parchment/50 p-3">
                <p className="text-xs font-semibold text-ink/55">전체 누적 기사</p>
                <p className="mt-2 text-3xl font-semibold tabular-nums text-ink">{count(snapshot.total.total)}<span className="ml-1 text-xs">건</span></p>
              </div>
              <PeriodMetric label="오늘 신규" recent={snapshot.total.recent1d} previous={snapshot.total.previous1d} />
              <PeriodMetric label="최근 7일 신규" recent={snapshot.total.recent7d} previous={snapshot.total.previous7d} />
              <PeriodMetric label="최근 30일 신규" recent={snapshot.total.recent30d} previous={snapshot.total.previous30d} />
            </div>
          </section>
          <section aria-labelledby="source-growth">
            <div className="mb-4 flex items-center gap-2">
              <Activity className="size-4 text-court" aria-hidden="true" />
              <h2 id="source-growth" className="text-base font-semibold text-ink">수집원별 증가 추세</h2>
            </div>
            {snapshot.sources.length === 0 ? <p className="rounded-lg border border-rule p-5 text-sm text-ink/60">등록된 수집원이 없습니다.</p> : null}
            <div className="grid gap-4 xl:grid-cols-2">
              {snapshot.sources.map((source) => <SourceCard key={source.sourceKey} source={source} />)}
            </div>
          </section>
          <p className="mt-5 text-xs leading-6 text-ink/55">
            집계 기준: D1 기사 테이블의 최초 등록일(created_at). 한국시간 달력일 기준이며 오늘은 현재 시각까지의 부분 집계입니다.
            최근 7일·30일은 오늘을 포함하며, 증감률은 바로 이전 동일 길이 기간과 비교합니다. 재수집·요약 재실행은 신규 기사 증가량에 포함하지 않습니다.
          </p>
        </>
      )}
    </div>
  );
}
