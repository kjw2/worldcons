import Link from "next/link";
import { ArrowLeft, Clock3, ExternalLink, KeyRound, Radio, ShieldCheck } from "lucide-react";
import { AdminWorkActionButton } from "@/components/admin-work-action";
import { AdminWorkState } from "@/components/admin-work-queue";
import { adminStateText, adminWorkStageText, adminWorkTypeText } from "@/lib/admin/p4/labels";
import type { AdminWorkItemDetail } from "@/lib/admin/p4/types";

function formatDateTime(value?: string | null) {
  if (!value) return "기록 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "기록 없음";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Seoul" }).format(date);
}

const timelineCategoryLabels: Record<string, string> = {
  execution: "실행",
  lifecycle: "기사 처리",
  publication: "공개",
  audit: "감사",
  outbox: "캐시 전달",
};

export function AdminWorkDetail({ detail, csrfToken }: { detail: AdminWorkItemDetail; csrfToken: string }) {
  const { item } = detail;
  return (
    <div className="min-w-0 py-6">
      <header className="border-b border-rule px-4 pb-6 sm:px-6">
        <Link href="/admin/work" className="focus-ring inline-flex min-h-9 items-center gap-2 rounded-md border border-rule bg-white px-3 text-sm font-semibold text-ink/65 hover:bg-parchment"><ArrowLeft className="size-4" aria-hidden="true" />통합 업무 큐</Link>
        <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-court">{adminWorkTypeText(item.type)} · {adminWorkStageText(item.stage)}</p>
            <h1 className="mt-1 max-w-4xl break-words text-2xl font-semibold text-ink">{item.title}</h1>
            <p className="mt-2 break-all text-sm text-ink/52">{item.target}</p>
          </div>
          <AdminWorkActionButton kind={item.type} id={item.id} action={item.safeAction} csrfToken={csrfToken} disabledReason={item.actionDisabledReason} />
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div><p className="mb-1 text-xs font-semibold text-ink/45">실행</p><AdminWorkState title="실행 상태" label={item.execution} /></div>
          <div><p className="mb-1 text-xs font-semibold text-ink/45">기사 처리</p><AdminWorkState title="기사 처리 상태" label={item.lifecycle} /></div>
          <div><p className="mb-1 text-xs font-semibold text-ink/45">공개</p><AdminWorkState title="공개 상태" label={item.publication} /></div>
        </div>
      </header>

      {detail.warnings.length > 0 ? <div className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:px-6">{detail.warnings.join(" ")}</div> : null}

      <section className="border-b border-rule px-4 py-5 sm:px-6" aria-labelledby="authority-status">
        <div className="flex items-center gap-2"><Radio className="size-4 text-court" aria-hidden="true" /><h2 id="authority-status" className="text-base font-semibold text-ink">실행 임대 및 권한</h2></div>
        <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <div><dt className="text-xs font-semibold text-ink/45">상태 신호</dt><dd className="mt-1 break-words text-ink/70">{formatDateTime(detail.heartbeatAt)}</dd></div>
          <div><dt className="text-xs font-semibold text-ink/45">임대 만료</dt><dd className="mt-1 break-words text-ink/70">{formatDateTime(detail.leaseExpiresAt)}</dd></div>
          <div><dt className="text-xs font-semibold text-ink/45">펜싱 토큰</dt><dd className="mt-1 break-all font-mono text-xs text-ink/70">{detail.fencingToken ?? "기록 없음"}</dd></div>
          <div><dt className="text-xs font-semibold text-ink/45">중단 요청</dt><dd className="mt-1 break-words text-ink/70">{formatDateTime(detail.abortRequestedAt)}</dd></div>
        </dl>
      </section>

      <section className="border-b border-rule bg-white px-4 py-5 sm:px-6" aria-labelledby="work-timeline">
        <div className="flex items-center gap-2"><Clock3 className="size-4 text-court" aria-hidden="true" /><h2 id="work-timeline" className="text-base font-semibold text-ink">안전한 운영 이력</h2></div>
        <p className="mt-1 text-xs text-ink/50">요청 본문, URL, 원문, 콘텐츠, 제공자 응답 및 비밀값은 의도적으로 제외합니다.</p>
        {detail.timeline.length === 0 ? <div className="mt-5 border-y border-dashed border-rule py-10 text-center text-sm text-ink/55">이 업무에서 표시할 수 있는 안전한 이벤트가 없습니다.</div> : (
          <ol className="mt-5 grid gap-0 border-t border-rule">
            {detail.timeline.map((event) => (
              <li key={`${event.category}:${event.id}`} className="grid gap-2 border-b border-rule py-3 text-sm md:grid-cols-[150px_minmax(180px,1fr)_160px_minmax(180px,1fr)] md:items-start">
                <div className="text-xs text-ink/50"><span className="block font-semibold text-court">{timelineCategoryLabels[event.category] ?? event.category}</span><span className="mt-1 block">{formatDateTime(event.occurredAt)}</span></div>
                <div className="min-w-0"><p className="break-words font-semibold text-ink">{event.title}</p><p className="mt-1 break-words text-xs text-ink/55">{adminStateText(event.state)}</p></div>
                <div className="min-w-0 text-xs"><p className="font-semibold text-ink/45">작업자</p><p className="mt-1 break-all text-ink/65">{event.actor ?? "시스템"}</p></div>
                <div className="min-w-0 text-xs"><p className="font-semibold text-ink/45">사유 / 연관 식별자</p><p className="mt-1 break-words text-ink/65">{event.reason ?? "기록된 사유 없음"}</p>{event.correlationId ? <p className="mt-1 break-all font-mono text-ink/48">{event.correlationId}</p> : null}</div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="px-4 py-5 sm:px-6" aria-labelledby="related-admin-pages">
        <div className="flex items-center gap-2"><ShieldCheck className="size-4 text-court" aria-hidden="true" /><h2 id="related-admin-pages" className="text-base font-semibold text-ink">관련 관리자 화면</h2></div>
        <div className="mt-4 flex flex-wrap gap-2">
          {detail.links.map((link) => <Link key={link.href} href={link.href} className="focus-ring inline-flex min-h-9 items-center gap-2 rounded-md border border-rule bg-white px-3 text-sm font-semibold text-ink/65 hover:bg-parchment">{link.label}<ExternalLink className="size-3.5" aria-hidden="true" /></Link>)}
        </div>
        <div className="mt-5 flex items-start gap-2 text-xs leading-5 text-ink/48"><KeyRound className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><p>검토 담당자 지정과 수동 캐시 전달 전환은 승인된 P2/P3 권한이 없어 사용할 수 없습니다. 기사 수정, 재번역, 재요약 및 변경 불가 원문 스냅샷 제어는 기사 상세 화면에서 계속 제공합니다.</p></div>
      </section>
    </div>
  );
}
