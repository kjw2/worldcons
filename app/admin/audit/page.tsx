import Link from "next/link";
import { redirect } from "next/navigation";
import { ClipboardList, Filter, LogOut, Search } from "lucide-react";
import { AdminTabs } from "@/components/admin-tabs";
import { getAdminAuditLogData, type AdminAuditLogEntry } from "@/lib/db/analytics";
import { createAdminCsrfToken, isAuthorizedPageRequest } from "@/lib/utils/auth";
import { getNumberSearchParam, getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatDateTime(input?: string | null) {
  if (!input) return "-";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function filterValue(value?: string) {
  return value ?? "";
}

function compactText(value?: string | null) {
  return value?.trim() || "-";
}

function withAuditParams(filters: { eventType?: string; action?: string; q?: string; page?: number; pageSize?: number }) {
  const params = new URLSearchParams();
  if (filters.eventType) params.set("eventType", filters.eventType);
  if (filters.action) params.set("action", filters.action);
  if (filters.q) params.set("q", filters.q);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  if (filters.pageSize && filters.pageSize !== 25) params.set("pageSize", String(filters.pageSize));
  const query = params.toString();
  return query ? `/admin/audit?${query}` : "/admin/audit";
}

function ResultBadge({ entry }: { entry: AdminAuditLogEntry }) {
  if (entry.error) {
    return <span className="inline-flex min-h-7 items-center rounded-md border border-court/25 bg-court/5 px-2.5 text-xs font-semibold text-court">오류</span>;
  }
  if (entry.result) {
    return <span className="inline-flex min-h-7 items-center rounded-md border border-mint/25 bg-mint/10 px-2.5 text-xs font-semibold text-mint">{entry.result}</span>;
  }
  return <span className="inline-flex min-h-7 items-center rounded-md border border-rule bg-parchment px-2.5 text-xs font-semibold text-ink/62">기록됨</span>;
}

function AuditTable({ entries }: { entries: AdminAuditLogEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-rule bg-white px-5 py-12 text-center text-sm text-ink/62">
        조건에 맞는 관리자 감사 로그가 없습니다.
      </div>
    );
  }

  return (
    <section className="rounded-md border border-rule bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-[1120px] divide-y divide-rule text-sm">
          <thead className="bg-parchment">
            <tr className="text-left text-xs font-semibold text-ink/60">
              <th className="px-4 py-3">시각</th>
              <th className="px-4 py-3">유형 / 작업</th>
              <th className="px-4 py-3">경로</th>
              <th className="px-4 py-3">대상</th>
              <th className="px-4 py-3">LLM</th>
              <th className="px-4 py-3">결과</th>
              <th className="px-4 py-3">오류</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {entries.map((entry) => (
              <tr key={entry.id} className="align-top transition hover:bg-parchment/35">
                <td className="whitespace-nowrap px-4 py-4 text-ink/72">{formatDateTime(entry.createdAt)}</td>
                <td className="px-4 py-4">
                  <div className="font-semibold text-ink">{entry.action}</div>
                  <div className="mt-1 text-xs text-ink/45">{entry.eventType}</div>
                </td>
                <td className="max-w-xs break-all px-4 py-4 text-ink/64">{compactText(entry.path)}</td>
                <td className="max-w-sm px-4 py-4">
                  <div className="break-all font-semibold text-ink/72">{compactText(entry.articleSlug)}</div>
                  <div className="mt-1 break-all text-xs text-ink/50">{compactText(entry.sourceKey)}</div>
                </td>
                <td className="max-w-sm px-4 py-4">
                  <div className="break-all text-ink/72">{compactText(entry.provider)}</div>
                  <div className="mt-1 break-all text-xs text-ink/50">{compactText(entry.model)}</div>
                </td>
                <td className="px-4 py-4">
                  <ResultBadge entry={entry} />
                </td>
                <td className="max-w-md px-4 py-4">
                  {entry.error ? <div className="break-words rounded-md border border-court/15 bg-court/5 p-2 text-xs leading-5 text-court">{entry.error}</div> : <span className="text-ink/45">-</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function AdminAuditPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const params = await resolveSearchParams(searchParams);
  const authorized = await isAuthorizedPageRequest();

  if (!authorized) {
    redirect(`/admin/login?next=${encodeURIComponent("/admin/audit")}`);
  }

  const data = await getAdminAuditLogData({
    eventType: getSearchParam(params, "eventType"),
    action: getSearchParam(params, "action"),
    q: getSearchParam(params, "q"),
    page: getNumberSearchParam(params, "page"),
    pageSize: getNumberSearchParam(params, "pageSize"),
  });
  const csrfToken = (await createAdminCsrfToken()) ?? "";
  const { filters, pageInfo } = data;
  const actionOptions =
    filters.action && !data.actionOptions.includes(filters.action)
      ? [filters.action, ...data.actionOptions]
      : data.actionOptions;

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-sm font-semibold text-court">관리자</p>
          <h1 className="text-3xl font-semibold tracking-normal text-ink">감사 로그</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink/66">
            `site_events`에 저장된 관리자 작업 이벤트를 읽기 전용으로 확인합니다.
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

      <AdminTabs active="audit" />

      <section className="mb-5 rounded-md border border-rule bg-white p-4 shadow-sm">
        <form className="grid gap-3 md:grid-cols-[180px_180px_minmax(220px,1fr)_120px_auto]">
          <label className="grid gap-1 text-sm font-medium text-ink/72">
            이벤트
            <select name="eventType" defaultValue={filterValue(filters.eventType)} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink">
              <option value="">전체</option>
              <option value="admin_action">admin_action</option>
              <option value="admin_review_action">admin_review_action</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-ink/72">
            작업
            <select name="action" defaultValue={filterValue(filters.action)} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink">
              <option value="">전체</option>
              {actionOptions.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-ink/72">
            검색
            <input name="q" defaultValue={filterValue(filters.q)} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink" placeholder="경로, slug, source, action" />
          </label>
          <label className="grid gap-1 text-sm font-medium text-ink/72">
            페이지 크기
            <select name="pageSize" defaultValue={String(filters.pageSize)} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm text-ink">
              {[25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2">
            <button type="submit" className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white hover:bg-ink/90">
              <Search className="size-4" aria-hidden="true" />
              조회
            </button>
            <Link href="/admin/audit" className="focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-rule bg-white px-3 text-sm font-semibold text-ink/70 hover:bg-parchment">
              <Filter className="size-4" aria-hidden="true" />
              초기화
            </Link>
          </div>
        </form>
      </section>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-white px-4 py-3 text-sm text-ink/64 shadow-sm">
        <span>데이터 기준: {data.hasDatabase ? (data.schemaReady ? "Supabase site_events" : "Supabase, migration 확인 필요") : "DB 미연결"}</span>
        <span>갱신 시각: {formatDateTime(data.generatedAt)}</span>
        <span className="inline-flex items-center gap-2 font-semibold text-ink/72">
          <ClipboardList className="size-4 text-court" aria-hidden="true" />
          총 {formatNumber(pageInfo.total)}건
        </span>
      </div>

      <AuditTable entries={data.entries} />

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="text-ink/58">
          {formatNumber(pageInfo.page)} / {formatNumber(Math.max(1, Math.ceil(pageInfo.total / pageInfo.pageSize)))} 페이지
        </span>
        <div className="flex gap-2">
          <Link
            href={withAuditParams({ ...filters, page: Math.max(1, pageInfo.page - 1) })}
            aria-disabled={pageInfo.page <= 1}
            className={`focus-ring inline-flex min-h-10 items-center rounded-md border border-rule px-4 font-semibold ${pageInfo.page <= 1 ? "pointer-events-none bg-parchment text-ink/35" : "bg-white text-ink/70 hover:bg-parchment"}`}
          >
            이전
          </Link>
          <Link
            href={withAuditParams({ ...filters, page: pageInfo.page + 1 })}
            aria-disabled={!pageInfo.hasMore}
            className={`focus-ring inline-flex min-h-10 items-center rounded-md border border-rule px-4 font-semibold ${!pageInfo.hasMore ? "pointer-events-none bg-parchment text-ink/35" : "bg-white text-ink/70 hover:bg-parchment"}`}
          >
            다음
          </Link>
        </div>
      </div>
    </main>
  );
}
