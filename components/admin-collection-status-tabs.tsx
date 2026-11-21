"use client";

import { useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { Activity, RefreshCw } from "lucide-react";
import type { StagedCollectionSnapshot } from "@/lib/admin/staged-collection-status";
import type { IngestionRunRecord } from "@/lib/db/types";
import type { AdminOpsEvent } from "@/lib/ops/watchdog";
import { displaySourceLabel } from "@/lib/ui/source-labels";

type TabKey = "sources" | "runs" | "events";
const tabs: Array<{ key: TabKey; label: string }> = [
  { key: "sources", label: "소스별 수집 상태" },
  { key: "runs", label: "최근 수집 실행" },
  { key: "events", label: "최근 운영 이벤트" },
];

const eventTypes: Record<string, string> = {
  watchdog_ok: "정상 확인",
  watchdog_violation: "주의 감지",
  watchdog_compensation: "보정 수집",
  watchdog_issue_filed: "경고 발행",
  watchdog_issue_updated: "경고 갱신",
  watchdog_issue_closed: "경고 종료",
  watchdog_error: "오류",
};
const stageNames: Record<string, string> = {
  discovery: "발견", crawl: "원문 수집", normalize: "정규화",
  translate: "번역", "public-judgment": "공개 판정", publish: "발행", search: "검색 반영",
};
const statusNames: Record<string, string> = {
  succeeded: "성공", completed: "완료", running: "실행 중",
  pending: "대기", leased: "처리 중", failed: "실패",
  dead_letter: "실패 종료", cancelled: "취소", partial: "부분 완료",
};
const count = (value: number) => new Intl.NumberFormat("ko-KR").format(value);

function formatTime(value?: string | null) {
  if (!value) return "기록 없음";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "시간 확인 불가";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

function State({ status }: { status: string }) {
  const trouble = status === "failed" || status === "dead_letter";
  const isDone = status === "completed" || status === "succeeded";
  return (
    <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${trouble
      ? "border-court/25 bg-court/5 text-court"
      : isDone ? "border-mint/25 bg-mint/10 text-mint" : "border-rule bg-parchment text-ink/70"}`}>
      {statusNames[status] ?? status}
    </span>
  );
}

function Unavailable({ title }: { title: string }) {
  return <p role="alert" className="rounded-lg border border-amber-300 bg-white p-4 text-sm text-ink/70">{title} 데이터를 확인하지 못했습니다. 0건으로 간주하지 않습니다.</p>;
}

function SourceOverview({
  staged, runs,
}: {
  staged: StagedCollectionSnapshot;
  runs: { available: boolean; items: IngestionRunRecord[] };
}) {
  const usLatest = runs.items.find((run) => run.sourceKey === "us-scotus");
  return (
    <section aria-label="소스별 수집 상태">
      <p className="mb-4 text-sm text-ink/60">
        독일·스페인·프랑스는 최신 발견 실행과 최근 후속 처리 이력을 별도로 표시하며, 미국은 기존 수집 실행 기록을 표시합니다.
        발견 단계 성공은 전체 기사 발행 완료를 의미하지 않습니다.
      </p>
      {!staged.available ? <div className="mb-4"><Unavailable title="단계별 수집" /></div> : null}
      {!runs.available ? <div className="mb-4"><Unavailable title="기존 수집 실행" /></div> : null}
      {staged.available ? (
        <div className="mb-4 grid gap-2 rounded-lg border border-rule bg-white p-4 text-xs text-ink/65 sm:grid-cols-2 lg:grid-cols-5">
          <span>미예약 발견 항목 <strong className="text-ink">{staged.observability.discoveryPendingCount ?? "-"}</strong></span>
          <span>가장 오래된 대기 <strong className="text-ink">{staged.observability.oldestDiscoveryPendingAgeSeconds === null ? "-" : `${count(Math.floor(staged.observability.oldestDiscoveryPendingAgeSeconds / 60))}분`}</strong></span>
          <span>rate-limit 종결 <strong className="text-ink">{staged.observability.redriveRateLimitedLastHour ?? "-"}</strong></span>
          <span>dispatch DLQ <strong className="text-ink">{staged.observability.dispatchOutboxDeadLetters ?? "-"}</strong></span>
          <span>bridge DLQ <strong className="text-ink">{staged.observability.bridgeOutboxDeadLetters ?? "-"}</strong></span>
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-rule bg-white">
        <table className="w-full min-w-[780px] text-left text-sm">
          <thead className="border-b border-rule bg-parchment/60 text-xs font-semibold text-ink/65">
            <tr>
              <th scope="col" className="px-4 py-3">수집원</th>
              <th scope="col" className="px-4 py-3">방식</th>
              <th scope="col" className="px-4 py-3">최근 시작</th>
              <th scope="col" className="px-4 py-3">발견·수집 상태</th>
              <th scope="col" className="px-4 py-3">최근 후속 처리</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {staged.available && staged.sources.map((source) => {
              const discovery = source.latestDiscovery;
              const followup = source.latestFollowup;
              return (
                <tr key={source.sourceKey}>
                  <th scope="row" className="px-4 py-4 font-semibold text-ink">{displaySourceLabel(source.sourceKey)}</th>
                  <td className="px-4 py-4 text-ink/65">단계별</td>
                  <td className="px-4 py-4 whitespace-nowrap text-ink/65">{formatTime(discovery?.startedAt)}</td>
                  <td className="px-4 py-4">{discovery ? <State status={discovery.status} /> : "기록 없음"}</td>
                  <td className="px-4 py-4 text-ink/65">
                    {followup ? (
                      <><span className="font-semibold">{stageNames[followup.stage] ?? followup.stage}</span>
                        {" · "}<State status={followup.status} />
                        <p className="mt-1 text-xs">{formatTime(followup.updatedAt)}</p>
                        {source.downstreamDeadLetterCount > 0 ? <p className="mt-1 text-xs font-semibold text-court">미복구 DLQ {count(source.downstreamDeadLetterCount)}건</p> : null}</>
                    ) : "후속 처리 이력 없음"}
                  </td>
                </tr>
              );
            })}
            {runs.available && (
              <tr>
                <th scope="row" className="px-4 py-4 font-semibold text-ink">{displaySourceLabel("us-scotus")}</th>
                <td className="px-4 py-4 text-ink/65">기존 수집</td>
                <td className="px-4 py-4 whitespace-nowrap text-ink/65">{formatTime(usLatest?.startedAt)}</td>
                <td className="px-4 py-4">{usLatest ? <State status={usLatest.status} /> : "기록 없음"}</td>
                <td className="px-4 py-4 text-ink/65">
                  {usLatest ? `수집 ${count(usLatest.fetchedCount)}건 · 실패 ${count(usLatest.failedCount)}건` : "기록 없음"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type RecentRun = {
  id: string;
  sourceKey: string;
  mode: string;
  startedAt: string;
  status: string;
  details: string;
};

function RecentRuns({
  staged, runs,
}: {
  staged: StagedCollectionSnapshot;
  runs: { available: boolean; items: IngestionRunRecord[] };
}) {
  const all: RecentRun[] = [
    ...(staged.available ? staged.recentDiscoveries.map((row) => ({
      id: `staged:${row.id}`, sourceKey: row.sourceKey, mode: "단계별 발견",
      startedAt: row.startedAt, status: row.status, details: "발견 단계 결과 · 후속 처리와 별도",
    })) : []),
    ...(runs.available ? runs.items.map((row) => ({
      id: `legacy:${row.id ?? `${row.sourceKey}:${row.startedAt}`}`,
      sourceKey: row.sourceKey, mode: "기존 수집", startedAt: row.startedAt,
      status: row.status, details: `수집 ${count(row.fetchedCount)}건 · 실패 ${count(row.failedCount)}건`,
    })) : []),
  ].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id)).slice(0, 30);
  return (
    <section aria-label="최근 수집 실행">
      <p className="mb-4 text-sm text-ink/60">최근 30건을 실행 시작 시각순으로 표시합니다. 단계별 수집의 발견 성공은 후속 처리 완료와 구분합니다.</p>
      {!staged.available || !runs.available ? <div className="mb-4"><Unavailable title="일부 실행 이력" /></div> : null}
      {all.length === 0 && staged.available && runs.available ? <p className="rounded-lg border border-rule p-5 text-sm text-ink/60">수집 실행 기록이 없습니다.</p> : (
        <div className="overflow-x-auto rounded-lg border border-rule bg-white">
          <table className="w-full min-w-[710px] text-left text-sm">
            <thead className="border-b border-rule bg-parchment/60 text-xs text-ink/65">
              <tr><th scope="col" className="px-4 py-3">수집원</th><th scope="col" className="px-4 py-3">방식</th><th scope="col" className="px-4 py-3">시작 시각</th><th scope="col" className="px-4 py-3">결과</th><th scope="col" className="px-4 py-3">처리 정보</th></tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {all.map((row) => <tr key={row.id}>
                <th scope="row" className="px-4 py-3 font-semibold text-ink">{displaySourceLabel(row.sourceKey)}</th>
                <td className="px-4 py-3 text-ink/60">{row.mode}</td>
                <td className="px-4 py-3 whitespace-nowrap text-ink/60">{formatTime(row.startedAt)}</td>
                <td className="px-4 py-3"><State status={row.status} /></td>
                <td className="px-4 py-3 text-ink/60">{row.details}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Events({ events }: { events: AdminOpsEvent[] }) {
  if (events.length === 0) return <p className="rounded-lg border border-rule p-5 text-sm text-ink/60">기록된 운영 이벤트가 없습니다.</p>;
  return (
    <section aria-label="최근 운영 이벤트">
      <ul className="grid gap-2">
        {events.map((event) => (
          <li key={event.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-white px-4 py-3 text-sm">
            <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${event.severity === "critical" ? "border-court/25 text-court" : event.severity === "warning" ? "border-amber-300 text-amber-800" : "border-rule text-ink/65"}`}>
              {event.severity === "critical" ? "치명" : event.severity === "warning" ? "경고" : "정보"}
            </span>
            <strong className="text-ink">{eventTypes[event.event_type] ?? event.event_type}</strong>
            <span className="min-w-0 flex-1 text-ink/65">{event.summary}</span>
            <time className="shrink-0 text-xs text-ink/50" dateTime={event.created_at}>{formatTime(event.created_at)}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AdminCollectionStatusTabs({
  staged, runs, events,
}: {
  staged: StagedCollectionSnapshot;
  runs: { available: boolean; items: IngestionRunRecord[] };
  events: { available: boolean; items: AdminOpsEvent[] };
}) {
  const [active, setActive] = useState<TabKey>("sources");
  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0
      : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    setActive(tabs[next].key);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[next]?.focus();
  }
  return (
    <div className="min-w-0 px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase text-court"><Activity className="size-4" aria-hidden="true" />수집</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink">수집현황</h1>
          <p className="mt-2 text-sm text-ink/60">소스별 실행 상태, 수집 기록과 운영 이벤트를 구분해 확인합니다.</p>
        </div>
        <Link href="/admin/ops" className="focus-ring inline-flex items-center gap-2 rounded-md border border-rule bg-white px-4 py-2 text-sm font-semibold text-ink hover:bg-parchment">
          <RefreshCw className="size-4" aria-hidden="true" />새로고침
        </Link>
      </header>
      <div role="tablist" aria-label="수집현황 보기" className="mb-5 flex w-full gap-1 overflow-x-auto border-b border-rule">
        {tabs.map((tab, index) => (
          <button key={tab.key} type="button" role="tab"
            id={`collection-tab-${tab.key}`} aria-controls={`collection-panel-${tab.key}`}
            aria-selected={active === tab.key} tabIndex={active === tab.key ? 0 : -1}
            onClick={() => setActive(tab.key)} onKeyDown={(event) => onTabKeyDown(event, index)}
            className={`focus-ring shrink-0 border-b-2 px-4 py-3 text-sm font-semibold transition-colors ${active === tab.key
              ? "border-court text-court" : "border-transparent text-ink/60 hover:border-rule hover:text-ink"}`}>
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div key={tab.key} id={`collection-panel-${tab.key}`} role="tabpanel"
          aria-labelledby={`collection-tab-${tab.key}`} tabIndex={0} hidden={active !== tab.key}
          className={active === tab.key ? "min-w-0" : "hidden"}>
          {active === tab.key && tab.key === "sources" ? <SourceOverview staged={staged} runs={runs} /> : null}
          {active === tab.key && tab.key === "runs" ? <RecentRuns staged={staged} runs={runs} /> : null}
          {active === tab.key && tab.key === "events"
            ? events.available ? <Events events={events.items} /> : <Unavailable title="운영 이벤트" />
            : null}
        </div>
      ))}
    </div>
  );
}
