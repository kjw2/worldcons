import Link from "next/link";
import { AlertTriangle, ArrowLeft, ArrowRight, Clock3, Search } from "lucide-react";
import { AdminWorkActionButton } from "@/components/admin-work-action";
import { adminWorkFiltersQuery } from "@/lib/admin/p4/filters";
import { adminSlaText, adminStateText, adminWorkStageText, adminWorkTypeText } from "@/lib/admin/p4/labels";
import type { AdminWorkFilters, AdminWorkItem, AdminWorkQueueSnapshot, AdminWorkStateLabel } from "@/lib/admin/p4/types";

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Seoul" }).format(new Date(value));
}

function stateClass(tone: AdminWorkStateLabel["tone"]) {
  if (tone === "success") return "border-mint/25 bg-mint/10 text-mint";
  if (tone === "danger") return "border-court/25 bg-court/5 text-court";
  if (tone === "warning") return "border-amber-400/40 bg-amber-50 text-amber-900";
  if (tone === "info") return "border-primary/20 bg-primary/5 text-primary";
  return "border-rule bg-white text-ink/55";
}

export function AdminWorkState({ label, title }: { label: AdminWorkStateLabel; title: string }) {
  const displayValue = adminStateText(label.value);
  return (
    <span className={`inline-flex min-h-7 max-w-full items-center rounded-md border px-2 text-xs font-semibold ${stateClass(label.tone)}`} title={`${title}: ${displayValue}`}>
      <span className="truncate">{displayValue}</span>
      <span className="sr-only"> {title}</span>
    </span>
  );
}
function ItemStates({ item }: { item: AdminWorkItem }) {
  return (
    <div className="grid min-w-[158px] gap-1.5">
      <div className="grid grid-cols-[62px_minmax(0,1fr)] items-center gap-1.5"><span className="text-[11px] font-semibold text-ink/40">실행</span><AdminWorkState title="실행 상태" label={item.execution} /></div>
      <div className="grid grid-cols-[62px_minmax(0,1fr)] items-center gap-1.5"><span className="text-[11px] font-semibold text-ink/40">처리 단계</span><AdminWorkState title="기사 처리 상태" label={item.lifecycle} /></div>
      <div className="grid grid-cols-[62px_minmax(0,1fr)] items-center gap-1.5"><span className="text-[11px] font-semibold text-ink/40">공개</span><AdminWorkState title="공개 상태" label={item.publication} /></div>
    </div>
  );
}

function WorkIdentity({ item }: { item: AdminWorkItem }) {
  return (
    <div className="min-w-0">
      <Link href={item.detailHref} className="focus-ring rounded-sm font-semibold text-ink hover:text-court">
        <span className="break-words">{item.title}</span>
      </Link>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink/52">
        <span className="font-semibold">{adminWorkTypeText(item.type)}</span>
        <span className="break-all">{item.target}</span>
        {item.compatibility ? <span className="rounded border border-amber-400/40 bg-amber-50 px-1.5 text-amber-900">호환 데이터</span> : null}
      </div>
    </div>
  );
}

function WorkMeta({ item }: { item: AdminWorkItem }) {
  return (
    <dl className="grid gap-1 text-xs leading-5 text-ink/58">
      <div className="flex justify-between gap-3"><dt>수집원</dt><dd className="break-all text-right font-semibold text-ink/70">{item.source ?? "-"}</dd></div>
      <div className="flex justify-between gap-3"><dt>단계</dt><dd className="font-semibold text-ink/70">{adminWorkStageText(item.stage)}</dd></div>
      <div className="flex justify-between gap-3"><dt>담당자</dt><dd className="max-w-40 truncate text-right">{item.owner ?? "미지정"}</dd></div>
      <div className="flex justify-between gap-3"><dt>시도</dt><dd>{item.attempts}회</dd></div>
    </dl>
  );
}

function MobileWorkItem({ item, csrfToken }: { item: AdminWorkItem; csrfToken: string }) {
  return (
    <article className="border-b border-rule px-4 py-4 last:border-b-0">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <WorkIdentity item={item} />
        {item.attention ? <AlertTriangle className="mt-1 size-4 shrink-0 text-court" aria-label="주의 필요" /> : null}
      </div>
      <div className="mt-3"><ItemStates item={item} /></div>
      <div className="mt-3"><WorkMeta item={item} /></div>
      <div className="mt-3 flex items-start justify-between gap-3 border-t border-rule pt-3">
        <div className="min-w-0 text-xs leading-5 text-ink/55">
          <div className="flex items-center gap-1.5"><Clock3 className="size-3.5" aria-hidden="true" />{formatDateTime(item.updatedAt)} · 처리 기한 {adminSlaText(item.slaState)}</div>
          {item.latestError ? <p className="mt-1 line-clamp-2 break-words text-court">{item.latestError}</p> : null}
        </div>
        <AdminWorkActionButton kind={item.type} id={item.id} action={item.safeAction} csrfToken={csrfToken} disabledReason={item.actionDisabledReason} />
      </div>
    </article>
  );
}

export function AdminWorkQueue({ snapshot, filters, csrfToken }: { snapshot: AdminWorkQueueSnapshot; filters: AdminWorkFilters; csrfToken: string }) {
  const start = snapshot.pageInfo.total === 0 ? 0 : (snapshot.pageInfo.page - 1) * snapshot.pageInfo.pageSize + 1;
  const end = start === 0 ? 0 : start + snapshot.items.length - 1;
  const previousQuery = adminWorkFiltersQuery(filters, { page: Math.max(1, filters.page - 1) });
  const nextQuery = adminWorkFiltersQuery(filters, { page: filters.page + 1 });

  return (
    <>
      <form action="/admin/work" className="grid gap-3 border-y border-rule bg-white px-4 py-4 sm:px-6 xl:grid-cols-8">
        <label className="grid gap-1 text-xs font-semibold text-ink/62">
          담당자
          <input name="owner" defaultValue={filters.owner ?? ""} className="focus-ring h-10 min-w-0 rounded-md border border-rule px-3 text-sm font-normal text-ink" />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-ink/62">단계<select name="stage" defaultValue={filters.stage ?? ""} className="focus-ring h-10 min-w-0 rounded-md border border-rule bg-white px-2 text-sm font-normal"><option value="">전체</option><option value="collect">수집</option><option value="process">처리·요약</option><option value="review">검토</option><option value="publish">공개</option></select></label>
        <label className="grid gap-1 text-xs font-semibold text-ink/62">수집원<input name="source" defaultValue={filters.source ?? ""} className="focus-ring h-10 min-w-0 rounded-md border border-rule px-3 text-sm font-normal" /></label>
        <label className="grid gap-1 text-xs font-semibold text-ink/62">유형<select name="type" defaultValue={filters.type ?? ""} className="focus-ring h-10 min-w-0 rounded-md border border-rule bg-white px-2 text-sm font-normal"><option value="">전체</option><option value="execution">실행</option><option value="article">기사</option><option value="candidate">URL 후보</option><option value="outbox">캐시 전달</option><option value="legacy">호환 작업</option></select></label>
        <label className="grid gap-1 text-xs font-semibold text-ink/62">상태<input name="state" defaultValue={filters.state ?? ""} className="focus-ring h-10 min-w-0 rounded-md border border-rule px-3 text-sm font-normal" /></label>
        <label className="grid gap-1 text-xs font-semibold text-ink/62">주의 여부<select name="attention" defaultValue={filters.attention} className="focus-ring h-10 min-w-0 rounded-md border border-rule bg-white px-2 text-sm font-normal"><option value="all">전체</option><option value="required">주의 필요</option><option value="clear">이상 없음</option></select></label>
        <label className="grid gap-1 text-xs font-semibold text-ink/62">처리 기한<select name="sla" defaultValue={filters.sla} className="focus-ring h-10 min-w-0 rounded-md border border-rule bg-white px-2 text-sm font-normal"><option value="all">전체</option><option value="breached">기한 초과</option><option value="due">기한 임박</option><option value="healthy">정상</option></select></label>
        <label className="grid gap-1 text-xs font-semibold text-ink/62">경과 시간<select name="age" defaultValue={filters.age} className="focus-ring h-10 min-w-0 rounded-md border border-rule bg-white px-2 text-sm font-normal"><option value="all">전체</option><option value="1h">1시간 이상</option><option value="24h">24시간 이상</option><option value="7d">7일 이상</option><option value="30d">30일 이상</option></select></label>
        <div className="flex flex-wrap items-end gap-2 xl:col-span-8">
          <label className="grid gap-1 text-xs font-semibold text-ink/62">정렬<select name="sort" defaultValue={filters.sort} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm font-normal"><option value="newest">최신순</option><option value="oldest">오래된순</option><option value="sla">기한 우선</option></select></label>
          <label className="grid gap-1 text-xs font-semibold text-ink/62">표시 건수<select name="pageSize" defaultValue={String(filters.pageSize)} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm font-normal"><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></label>
          <button type="submit" className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white hover:bg-ink/90"><Search className="size-4" aria-hidden="true" />적용</button>
          <Link href="/admin/work" className="focus-ring inline-flex h-10 items-center rounded-md border border-rule bg-white px-4 text-sm font-semibold text-ink/65 hover:bg-parchment">초기화</Link>
        </div>
      </form>

      {snapshot.warnings.length > 0 ? (
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:px-6" role="status">
          <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" aria-hidden="true" />호환 모드</div>
          <ul className="mt-1 grid gap-1">{snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </div>
      ) : null}

      <div className="flex min-h-12 items-center justify-between gap-3 px-4 py-2 text-xs text-ink/55 sm:px-6">
        <span>전체 {snapshot.pageInfo.total.toLocaleString("ko-KR")}건 · {start}-{end}</span>
        <span>{snapshot.pageInfo.truncated ? "제한된 조회 결과입니다. 전체 결과는 필터 범위를 좁혀 확인하세요." : formatDateTime(snapshot.generatedAt)}</span>
      </div>

      {snapshot.items.length === 0 ? (
        <div className="border-y border-dashed border-rule bg-white px-5 py-16 text-center">
          <h2 className="text-base font-semibold text-ink">조건에 맞는 업무가 없습니다</h2>
          <p className="mt-2 text-sm text-ink/55">필터를 초기화하거나 범위를 넓혀보세요. 사용할 수 없는 P0-P3 데이터는 빈 호환 상태로 처리됩니다.</p>
        </div>
      ) : (
        <section className="border-y border-rule bg-white" aria-label="통합 관리자 업무">
          <div className="md:hidden">{snapshot.items.map((item) => <MobileWorkItem key={`${item.type}:${item.id}`} item={item} csrfToken={csrfToken} />)}</div>
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-[1180px] table-fixed divide-y divide-rule text-sm">
              <caption className="sr-only">실행, 기사 처리, 공개 상태가 독립적으로 표시되는 통합 업무 큐</caption>
              <thead className="bg-parchment">
                <tr className="text-left text-xs font-semibold text-ink/58"><th className="w-[260px] px-3 py-3">업무</th><th className="w-[160px] px-3 py-3">수집원 / 단계</th><th className="w-[240px] px-3 py-3">독립 상태</th><th className="w-[150px] px-3 py-3">경과 / 처리 기한</th><th className="w-[220px] px-3 py-3">오류 / 담당자</th><th className="w-[130px] px-3 py-3">가능한 다음 조치</th></tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {snapshot.items.map((item) => (
                  <tr key={`${item.type}:${item.id}`} className="align-top hover:bg-parchment/30">
                    <td className="px-3 py-3"><WorkIdentity item={item} /></td>
                    <td className="px-3 py-3"><div className="break-all font-semibold text-ink/70">{item.source ?? "-"}</div><div className="mt-1 text-xs text-ink/50">{adminWorkStageText(item.stage)} · {item.attempts}회 시도</div></td>
                    <td className="px-3 py-3"><ItemStates item={item} /></td>
                    <td className="px-3 py-3 text-xs leading-5 text-ink/58"><div>{formatDateTime(item.updatedAt)}</div><div className={item.slaState === "breached" ? "mt-1 font-semibold text-court" : "mt-1 font-semibold text-ink/65"}>처리 기한 {adminSlaText(item.slaState)}</div></td>
                    <td className="px-3 py-3 text-xs leading-5"><div className="line-clamp-2 break-words text-court">{item.latestError ?? "현재 표시할 안전한 오류 없음"}</div><div className="mt-1 max-w-48 truncate text-ink/48">{item.owner ?? "미지정"}</div></td>
                    <td className="px-3 py-3"><AdminWorkActionButton kind={item.type} id={item.id} action={item.safeAction} csrfToken={csrfToken} disabledReason={item.actionDisabledReason} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <nav className="flex items-center justify-between gap-3 px-4 py-5 sm:px-6" aria-label="업무 큐 페이지">
        <Link href={`/admin/work${previousQuery ? `?${previousQuery}` : ""}`} aria-disabled={filters.page <= 1} className={`focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-rule px-4 text-sm font-semibold ${filters.page <= 1 ? "pointer-events-none bg-parchment text-ink/35" : "bg-white text-ink/70 hover:bg-parchment"}`}><ArrowLeft className="size-4" aria-hidden="true" />이전</Link>
        <span className="text-sm font-semibold text-ink/55">{filters.page}페이지</span>
        <Link href={`/admin/work?${nextQuery}`} aria-disabled={!snapshot.pageInfo.hasMore} className={`focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-rule px-4 text-sm font-semibold ${snapshot.pageInfo.hasMore ? "bg-white text-ink/70 hover:bg-parchment" : "pointer-events-none bg-parchment text-ink/35"}`}>다음<ArrowRight className="size-4" aria-hidden="true" /></Link>
      </nav>
    </>
  );
}
