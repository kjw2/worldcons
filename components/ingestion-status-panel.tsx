import { Activity, AlertTriangle, CheckCircle2, Clock3, Database, XCircle } from "lucide-react";
import type { IngestionRunRecord } from "@/lib/db/types";
import { cn } from "@/lib/utils/classnames";
import { displaySourceLabel } from "@/lib/ui/source-labels";

interface DiagnosticAttempt {
  url?: string;
  strategy?: string;
  status?: number;
  errorCode?: string;
  errorMessage?: string;
  result?: string;
  timeoutPhase?: string;
  textLength?: number;
  recommendedAction?: string;
  robotsAllowed?: boolean;
  robotsMatchedRule?: string;
  robotsMatchedDirective?: string;
  robotsCrawlDelaySeconds?: number;
  maxConcurrency?: number;
  selectorMatchCount?: number;
  discoveredCount?: number;
  fallback?: boolean;
}

interface CollectionCounts {
  publishableCount?: number;
  metadataOnlyCount?: number;
  robotsDisallowedCount?: number;
  blockedCount?: number;
  timeoutCount?: number;
  seedCount?: number;
}

type RunTone = "success" | "warning" | "danger" | "running" | "neutral";

const statusLabels: Record<string, string> = {
  completed: "완료",
  running: "실행 중",
  failed: "실패",
  partial: "부분 완료",
};

function diagnosticsFor(run: IngestionRunRecord) {
  const metadata = run.metadata as { diagnostics?: { attempts?: DiagnosticAttempt[] }; fallbackUsed?: boolean; collectionCounts?: CollectionCounts } | null | undefined;
  return {
    attempts: metadata?.diagnostics?.attempts ?? [],
    fallbackUsed: Boolean(metadata?.fallbackUsed),
    collectionCounts: metadata?.collectionCounts ?? {},
  };
}

function formatNumber(value?: number | null) {
  return new Intl.NumberFormat("ko-KR").format(value ?? 0);
}

function formatCompactNumber(value?: number | null) {
  return value === undefined || value === null ? "-" : formatNumber(value);
}

function formatDateTime(input?: string | null) {
  if (!input) return "진행 중";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "날짜 미상";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function durationLabel(startedAt?: string | null, finishedAt?: string | null) {
  if (!startedAt) return "-";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "-";

  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds ? `${minutes}분 ${restSeconds}초` : `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}시간 ${restMinutes}분` : `${hours}시간`;
}

function runTone(run: IngestionRunRecord): RunTone {
  if (run.status === "running") return "running";
  if (run.status === "failed" || run.failedCount > 0 || run.errorMessage) return "danger";
  if (run.status === "completed") return "success";
  if (run.status === "partial") return "warning";
  return "neutral";
}

function toneClassName(tone: RunTone) {
  if (tone === "success") return "border-mint/25 bg-mint/10 text-mint";
  if (tone === "running") return "border-ink/15 bg-parchment text-ink/72";
  if (tone === "warning") return "border-amber-400/40 bg-amber-50 text-amber-800";
  if (tone === "danger") return "border-court/25 bg-court/5 text-court";
  return "border-rule bg-white text-ink/64";
}

function StatusBadge({ run }: { run: IngestionRunRecord }) {
  const tone = runTone(run);
  return (
    <span className={cn("inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold", toneClassName(tone))}>
      {statusLabels[run.status] ?? run.status}
    </span>
  );
}

function ResultPill({ label, value, tone = "neutral" }: { label: string; value?: number | null; tone?: RunTone }) {
  return (
    <span className={cn("inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold", toneClassName(tone))}>
      <span className="text-ink/58">{label}</span>
      <span>{formatCompactNumber(value)}</span>
    </span>
  );
}

function SummaryMetric({
  label,
  value,
  detail,
  icon: Icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Activity;
  tone?: RunTone;
}) {
  return (
    <section className="rounded-md border border-rule bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-ink/64">{label}</span>
        <span className={cn("inline-flex size-9 items-center justify-center rounded-md border", toneClassName(tone))}>
          <Icon className="size-4" aria-hidden="true" />
        </span>
      </div>
      <div className="text-2xl font-semibold tracking-normal text-ink">{value}</div>
      <p className="mt-1 text-xs leading-5 text-ink/56">{detail}</p>
    </section>
  );
}

function aggregateRuns(runs: IngestionRunRecord[]) {
  return runs.reduce(
    (summary, run) => {
      summary.discovered += run.discoveredCount;
      summary.fetched += run.fetchedCount;
      summary.summarized += run.summarizedCount;
      summary.failed += run.failedCount;
      if (run.status === "running") summary.running += 1;
      if (runTone(run) === "success") summary.completed += 1;
      if (runTone(run) === "danger") summary.problem += 1;
      return summary;
    },
    {
      discovered: 0,
      fetched: 0,
      summarized: 0,
      failed: 0,
      completed: 0,
      problem: 0,
      running: 0,
    },
  );
}

function AttemptBadge({ attempt }: { attempt: DiagnosticAttempt }) {
  const failed = attempt.result === "failed" || attempt.errorCode || attempt.errorMessage;
  const success = attempt.result === "success" || (attempt.status && attempt.status >= 200 && attempt.status < 300);
  const tone: RunTone = failed ? "danger" : success ? "success" : "neutral";

  return (
    <div className="rounded-md border border-rule bg-white p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("inline-flex min-h-6 items-center rounded-md border px-2 font-semibold", toneClassName(tone))}>
          {attempt.result ?? attempt.status ?? "진단"}
        </span>
        <span className="font-semibold text-ink">{attempt.strategy ?? "strategy 없음"}</span>
        {attempt.status ? <span className="text-ink/58">HTTP {attempt.status}</span> : null}
        {attempt.discoveredCount !== undefined ? <span className="text-ink/58">발견 {formatNumber(attempt.discoveredCount)}</span> : null}
        {attempt.textLength !== undefined ? <span className="text-ink/58">본문 {formatNumber(attempt.textLength)}자</span> : null}
        {attempt.selectorMatchCount !== undefined ? <span className="text-ink/58">selector {formatNumber(attempt.selectorMatchCount)}</span> : null}
        {attempt.fallback ? <span className="text-ink/58">fallback</span> : null}
        {attempt.robotsAllowed !== undefined ? <span className="text-ink/58">robots {attempt.robotsAllowed ? "허용" : "차단"}</span> : null}
      </div>
      {attempt.url ? <div className="mt-2 break-all text-ink/50">{attempt.url}</div> : null}
      {attempt.errorCode || attempt.errorMessage ? (
        <div className="mt-2 rounded-md border border-court/15 bg-court/5 p-2 text-court">
          {attempt.errorCode ? `${attempt.errorCode}: ` : ""}
          {attempt.errorMessage}
        </div>
      ) : null}
      {attempt.recommendedAction ? <div className="mt-2 text-ink/56">조치: {attempt.recommendedAction}</div> : null}
      {attempt.robotsMatchedRule ? (
        <div className="mt-2 text-ink/50">
          robots rule: {attempt.robotsMatchedDirective ?? "-"} {attempt.robotsMatchedRule}
        </div>
      ) : null}
      {attempt.timeoutPhase ? <div className="mt-2 text-ink/50">timeout: {attempt.timeoutPhase}</div> : null}
      {attempt.maxConcurrency ? <div className="mt-2 text-ink/50">maxConcurrency: {attempt.maxConcurrency}</div> : null}
      {attempt.robotsCrawlDelaySeconds !== undefined ? <div className="mt-2 text-ink/50">crawl-delay: {attempt.robotsCrawlDelaySeconds}s</div> : null}
    </div>
  );
}

function RunDiagnostics({ run, attempts, fallbackUsed }: { run: IngestionRunRecord; attempts: DiagnosticAttempt[]; fallbackUsed: boolean }) {
  if (attempts.length === 0 && !run.errorMessage && !fallbackUsed) {
    return <span className="text-xs text-ink/45">없음</span>;
  }

  return (
    <details className="group">
      <summary className="focus-ring inline-flex min-h-8 cursor-pointer list-none items-center rounded-md border border-rule bg-white px-2.5 text-xs font-semibold text-ink/70 transition hover:border-line-strong hover:bg-parchment marker:hidden">
        진단 {formatNumber(attempts.length)}건
      </summary>
      <div className="mt-3 min-w-[min(760px,calc(100vw-2rem))] rounded-md border border-rule bg-parchment/35 p-3">
        {run.errorMessage ? <div className="mb-3 rounded-md border border-court/20 bg-white p-3 text-xs leading-5 text-court">{run.errorMessage}</div> : null}
        {fallbackUsed ? <div className="mb-3 rounded-md border border-amber-400/30 bg-amber-50 p-3 text-xs leading-5 text-amber-800">fallback 경로가 사용되었습니다.</div> : null}
        {attempts.length > 0 ? (
          <div className="grid gap-2">
            {attempts.slice(0, 8).map((attempt, index) => (
              <AttemptBadge key={`${attempt.strategy}-${attempt.url}-${index}`} attempt={attempt} />
            ))}
            {attempts.length > 8 ? <div className="text-xs text-ink/50">나머지 {formatNumber(attempts.length - 8)}건은 최근 실행 metadata에 보존되어 있습니다.</div> : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

export function IngestionStatusPanel({ runs }: { runs: IngestionRunRecord[] }) {
  if (runs.length === 0) {
    return <div className="rounded-md border border-dashed border-rule bg-white px-5 py-12 text-center text-sm text-ink/62">수집 실행 기록이 없습니다.</div>;
  }

  const summary = aggregateRuns(runs);
  const latestRun = runs[0];

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryMetric label="최근 실행" value={displaySourceLabel(latestRun.sourceKey)} detail={`${formatDateTime(latestRun.startedAt)} 시작`} icon={Activity} tone={runTone(latestRun)} />
        <SummaryMetric label="완료/문제" value={`${formatNumber(summary.completed)} / ${formatNumber(summary.problem)}`} detail={`${formatNumber(runs.length)}개 실행 기준`} icon={summary.problem > 0 ? AlertTriangle : CheckCircle2} tone={summary.problem > 0 ? "danger" : "success"} />
        <SummaryMetric label="수집 결과" value={formatNumber(summary.fetched)} detail={`발견 ${formatNumber(summary.discovered)}건, 실패 ${formatNumber(summary.failed)}건`} icon={Database} tone={summary.failed > 0 ? "warning" : "neutral"} />
        <SummaryMetric label="요약 완료" value={formatNumber(summary.summarized)} detail={summary.running > 0 ? `${formatNumber(summary.running)}개 실행 중` : "최근 실행 합산"} icon={summary.running > 0 ? Clock3 : CheckCircle2} tone={summary.running > 0 ? "running" : "success"} />
      </div>

      <section className="rounded-md border border-rule bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule p-4">
          <div>
            <h2 className="text-lg font-semibold tracking-normal text-ink">최근 실행 50건</h2>
            <p className="mt-1 text-sm text-ink/58">핵심 지표만 먼저 보고, 필요한 실행만 진단을 펼쳐 확인합니다.</p>
          </div>
          {summary.problem > 0 ? (
            <span className="inline-flex min-h-8 items-center gap-2 rounded-md border border-court/25 bg-court/5 px-3 text-xs font-semibold text-court">
              <XCircle className="size-4" aria-hidden="true" />
              문제 실행 {formatNumber(summary.problem)}건
            </span>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[1120px] divide-y divide-rule text-sm">
            <thead className="bg-parchment">
              <tr className="text-left text-xs font-semibold text-ink/60">
                <th className="px-4 py-3">실행</th>
                <th className="px-4 py-3">상태</th>
                <th className="px-4 py-3">기간</th>
                <th className="px-4 py-3">수집 결과</th>
                <th className="px-4 py-3">공개 분류</th>
                <th className="px-4 py-3">진단</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {runs.map((run) => {
                const diagnostics = diagnosticsFor(run);
                const counts = diagnostics.collectionCounts;
                return (
                  <tr key={`${run.sourceKey}-${run.startedAt}`} className="align-top transition hover:bg-parchment/35">
                    <td className="px-4 py-4">
                      <div className="font-semibold text-ink">{displaySourceLabel(run.sourceKey)}</div>
                      <div className="mt-1 text-xs text-ink/50">{run.sourceKey}</div>
                      <div className="mt-2 text-xs text-ink/58">{formatDateTime(run.startedAt)} 시작</div>
                    </td>
                    <td className="px-4 py-4">
                      <StatusBadge run={run} />
                      <div className="mt-2 text-xs text-ink/50">{run.finishedAt ? `${formatDateTime(run.finishedAt)} 종료` : "종료 대기"}</div>
                    </td>
                    <td className="px-4 py-4 text-sm font-semibold text-ink/72">{durationLabel(run.startedAt, run.finishedAt)}</td>
                    <td className="px-4 py-4">
                      <div className="flex max-w-sm flex-wrap gap-1.5">
                        <ResultPill label="발견" value={run.discoveredCount} />
                        <ResultPill label="수집" value={run.fetchedCount} tone="success" />
                        <ResultPill label="요약" value={run.summarizedCount} tone="success" />
                        <ResultPill label="실패" value={run.failedCount} tone={run.failedCount > 0 ? "danger" : "neutral"} />
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex max-w-sm flex-wrap gap-1.5">
                        <ResultPill label="공개" value={counts.publishableCount} tone="success" />
                        <ResultPill label="메타" value={counts.metadataOnlyCount} tone={counts.metadataOnlyCount ? "warning" : "neutral"} />
                        <ResultPill label="robots" value={counts.robotsDisallowedCount} tone={counts.robotsDisallowedCount ? "warning" : "neutral"} />
                        <ResultPill label="차단" value={counts.blockedCount} tone={counts.blockedCount ? "danger" : "neutral"} />
                        <ResultPill label="timeout" value={counts.timeoutCount} tone={counts.timeoutCount ? "danger" : "neutral"} />
                        <ResultPill label="seed" value={counts.seedCount} />
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <RunDiagnostics run={run} attempts={diagnostics.attempts} fallbackUsed={diagnostics.fallbackUsed} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
