import Link from "next/link";
import { redirect } from "next/navigation";
import { Ban, ExternalLink, RefreshCw, RotateCcw, Search } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ARTICLE_CONTENT_TYPES } from "@/lib/db/types";
import { listSources } from "@/lib/db/queries";
import { listSourceUrlCandidates, SOURCE_URL_CANDIDATE_STATUSES, type SourceUrlCandidateRecord } from "@/lib/db/source-url-candidates";
import { displaySourceLabel } from "@/lib/ui/source-labels";
import { createAdminCsrfToken, isAuthorizedPageRequest } from "@/lib/utils/auth";
import { getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const statusLabels: Record<string, string> = {
  pending: "대기",
  retrying: "재시도",
  fetched: "수집됨",
  failed: "실패",
  ignored: "무시",
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

function statusClass(status: string) {
  if (status === "fetched") return "border-mint/25 bg-mint/10 text-mint";
  if (status === "retrying") return "border-amber-400/40 bg-amber-50 text-amber-800";
  if (status === "failed") return "border-court/25 bg-court/5 text-court";
  if (status === "ignored") return "border-rule bg-parchment text-ink/58";
  return "border-rule bg-white text-ink/64";
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold ${statusClass(status)}`}>
      {statusLabels[status] ?? status}
    </span>
  );
}

function searchParamsToString(params: SearchParams) {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) if (item) next.append(key, item);
    } else if (value) {
      next.set(key, value);
    }
  }
  return next.toString();
}

function pageHref(params: SearchParams, page: number) {
  const next = new URLSearchParams(searchParamsToString(params));
  if (page <= 1) next.delete("page");
  else next.set("page", String(page));
  const query = next.toString();
  return query ? `/admin/candidates?${query}` : "/admin/candidates";
}

function CandidateActions({ candidate, csrfToken, returnTo }: { candidate: SourceUrlCandidateRecord; csrfToken: string; returnTo: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <form action="/api/admin/candidates" method="post">
        <input type="hidden" name="csrfToken" value={csrfToken} />
        <input type="hidden" name="candidateId" value={candidate.id} />
        <input type="hidden" name="action" value="retrying" />
        <input type="hidden" name="returnTo" value={returnTo} />
        <button
          type="submit"
          disabled={candidate.status === "retrying"}
          className="focus-ring inline-flex min-h-9 items-center gap-2 rounded-md border border-rule bg-white px-3 text-xs font-semibold text-ink/70 hover:bg-parchment disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          재시도 표시
        </button>
      </form>
      <form action="/api/admin/candidates" method="post">
        <input type="hidden" name="csrfToken" value={csrfToken} />
        <input type="hidden" name="candidateId" value={candidate.id} />
        <input type="hidden" name="action" value="ignore" />
        <input type="hidden" name="returnTo" value={returnTo} />
        <button
          type="submit"
          disabled={candidate.status === "ignored"}
          className="focus-ring inline-flex min-h-9 items-center gap-2 rounded-md border border-rule bg-white px-3 text-xs font-semibold text-ink/62 hover:bg-parchment disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Ban className="size-3.5" aria-hidden="true" />
          무시
        </button>
      </form>
    </div>
  );
}

function CandidateTable({ candidates, csrfToken, returnTo }: { candidates: SourceUrlCandidateRecord[]; csrfToken: string; returnTo: string }) {
  return (
    <section className="rounded-md border border-rule bg-white shadow-sm">
      <div className="grid gap-3 p-4 md:hidden">
        {candidates.map((candidate) => (
          <article key={candidate.id} className="rounded-md border border-rule bg-parchment/25 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="break-words font-semibold text-ink">{displaySourceLabel(candidate.sourceKey)}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink/56">
                  <span className="break-all">{candidate.sourceKey}</span>
                  <span>유형 {candidate.candidateType}</span>
                </div>
              </div>
              <StatusBadge status={candidate.status} />
            </div>
            <a
              href={candidate.url}
              target="_blank"
              rel="noreferrer"
              className="focus-ring mt-3 inline-flex max-w-full items-start gap-1 break-all text-xs leading-5 text-court hover:underline"
            >
              {candidate.url}
              <ExternalLink className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            </a>
            <dl className="mt-3 grid gap-2 text-xs leading-5 text-ink/60">
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="font-semibold text-ink/45">발견</dt>
                <dd className="max-w-full break-words text-right font-semibold text-ink/72">{candidate.discoveredBy}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="font-semibold text-ink/45">시도</dt>
                <dd className="text-right">{formatNumber(candidate.attemptCount)}회</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="font-semibold text-ink/45">첫 발견</dt>
                <dd className="text-right">{formatDateTime(candidate.firstSeenAt)}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="font-semibold text-ink/45">최근 갱신</dt>
                <dd className="text-right">{formatDateTime(candidate.lastSeenAt)}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="font-semibold text-ink/45">최근 시도</dt>
                <dd className="text-right">{formatDateTime(candidate.lastAttemptAt)}</dd>
              </div>
            </dl>
            <div className="mt-3 rounded-md border border-rule bg-white p-2 text-xs leading-5 text-ink/58">
              {candidate.lastErrorCode ? <div className="font-semibold text-court">{candidate.lastErrorCode}</div> : <div className="text-ink/45">오류 없음</div>}
              {candidate.lastErrorMessage ? <div className="mt-1 break-words text-ink/58">{candidate.lastErrorMessage}</div> : null}
            </div>
            <div className="mt-3">
              <CandidateActions candidate={candidate} csrfToken={csrfToken} returnTo={returnTo} />
            </div>
          </article>
        ))}
      </div>

      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-[1280px] divide-y divide-rule text-sm">
          <thead className="bg-parchment">
            <tr className="text-left text-xs font-semibold text-ink/60">
              <th className="px-4 py-3">후보</th>
              <th className="px-4 py-3">상태</th>
              <th className="px-4 py-3">발견</th>
              <th className="px-4 py-3">오류</th>
              <th className="px-4 py-3">시각</th>
              <th className="px-4 py-3">조치</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {candidates.map((candidate) => (
              <tr key={candidate.id} className="align-top transition hover:bg-parchment/35">
                <td className="px-4 py-4">
                  <div className="font-semibold text-ink">{displaySourceLabel(candidate.sourceKey)}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink/56">
                    <span>{candidate.sourceKey}</span>
                    <span>유형 {candidate.candidateType}</span>
                  </div>
                  <a
                    href={candidate.url}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-ring mt-2 inline-flex max-w-xl items-start gap-1 break-all text-xs leading-5 text-court hover:underline"
                  >
                    {candidate.url}
                    <ExternalLink className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  </a>
                </td>
                <td className="px-4 py-4">
                  <StatusBadge status={candidate.status} />
                  <div className="mt-2 text-xs text-ink/50">시도 {formatNumber(candidate.attemptCount)}회</div>
                </td>
                <td className="px-4 py-4">
                  <div className="font-semibold text-ink/72">{candidate.discoveredBy}</div>
                  <div className="mt-1 text-xs text-ink/50">유형: {candidate.candidateType}</div>
                </td>
                <td className="px-4 py-4">
                  {candidate.lastErrorCode ? <div className="font-semibold text-court">{candidate.lastErrorCode}</div> : <span className="text-ink/45">없음</span>}
                  {candidate.lastErrorMessage ? <div className="mt-2 max-w-md text-xs leading-5 text-ink/58">{candidate.lastErrorMessage}</div> : null}
                </td>
                <td className="px-4 py-4 text-xs leading-5 text-ink/58">
                  <div>첫 발견: {formatDateTime(candidate.firstSeenAt)}</div>
                  <div>최근 갱신: {formatDateTime(candidate.lastSeenAt)}</div>
                  <div>최근 시도: {formatDateTime(candidate.lastAttemptAt)}</div>
                </td>
                <td className="px-4 py-4">
                  <CandidateActions candidate={candidate} csrfToken={csrfToken} returnTo={returnTo} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function AdminCandidatesPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const params = await resolveSearchParams(searchParams);
  const queryString = searchParamsToString(params);
  const currentPath = queryString ? `/admin/candidates?${queryString}` : "/admin/candidates";
  const authorized = await isAuthorizedPageRequest();
  if (!authorized) {
    redirect(`/admin/login?next=${encodeURIComponent(currentPath)}`);
  }

  const source = getSearchParam(params, "source") ?? "";
  const status = getSearchParam(params, "status") ?? "";
  const type = getSearchParam(params, "type") ?? "";
  const q = getSearchParam(params, "q") ?? "";
  const actionStatus = getSearchParam(params, "updated");
  const [result, sources, csrfTokenValue] = await Promise.all([
    listSourceUrlCandidates({
      sourceKey: source,
      status,
      candidateType: type,
      q,
      page: getSearchParam(params, "page"),
      pageSize: getSearchParam(params, "pageSize"),
    }),
    listSources(),
    createAdminCsrfToken(),
  ]);
  const csrfToken = csrfTokenValue ?? "";
  const { page, pageSize, total } = result.pageInfo;
  const startItem = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endItem = Math.min(total, page * pageSize);
  const hasPrevious = page > 1;
  const hasNext = endItem < total;

  return (
    <div className="min-w-0 px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-court">Content</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink">URL 후보</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink/66">
            공식 상세 확인 실패나 수집 후보로 보존된 URL을 검토하고 추적 상태를 조정합니다.
          </p>
        </div>
        <Link href={currentPath} className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink/90">
          <RefreshCw className="size-4" aria-hidden="true" />
          새로고침
        </Link>
      </div>

      {actionStatus === "ignored" || actionStatus === "retrying" ? (
        <div className="mb-5 rounded-md border border-rule bg-white px-4 py-3 text-sm font-semibold text-ink/72 shadow-sm">
          {actionStatus === "ignored" ? "후보를 무시 상태로 변경했습니다." : "후보를 재시도 추적 상태로 변경했습니다."}
        </div>
      ) : null}

      <form method="get" className="mb-5 rounded-md border border-rule bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_180px_130px]">
          <label className="grid gap-1 text-sm font-semibold text-ink/70">
            검색
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink/40" aria-hidden="true" />
              <input name="q" defaultValue={q} className="focus-ring h-10 w-full rounded-md border border-rule pl-9 pr-3 font-normal text-ink" placeholder="URL, 오류, 발견 경로" />
            </div>
          </label>
          <label className="grid gap-1 text-sm font-semibold text-ink/70">
            기관
            <select name="source" defaultValue={source} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 font-normal text-ink">
              <option value="">전체</option>
              {sources.map((item) => (
                <option key={item.sourceKey} value={item.sourceKey}>
                  {displaySourceLabel(item)} · {item.sourceKey}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-semibold text-ink/70">
            상태
            <select name="status" defaultValue={status} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 font-normal text-ink">
              <option value="">전체</option>
              {SOURCE_URL_CANDIDATE_STATUSES.map((item) => (
                <option key={item} value={item}>
                  {statusLabels[item]}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-semibold text-ink/70">
            후보 유형
            <select name="type" defaultValue={type} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 font-normal text-ink">
              <option value="">전체</option>
              {ARTICLE_CONTENT_TYPES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="submit" className="focus-ring inline-flex min-h-10 items-center gap-2 rounded-md bg-court px-4 text-sm font-semibold text-white hover:bg-court/90">
            <Search className="size-4" aria-hidden="true" />
            필터 적용
          </button>
          <Link href="/admin/candidates" className="focus-ring inline-flex min-h-10 items-center rounded-md border border-rule bg-white px-4 text-sm font-semibold text-ink/66 hover:bg-parchment">
            초기화
          </Link>
        </div>
      </form>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-white px-4 py-3 text-sm text-ink/64 shadow-sm">
        <span>
          총 {formatNumber(total)}건 중 {formatNumber(startItem)}-{formatNumber(endItem)} 표시
          {result.pageInfo.totalIsExact ? "" : " (검색 상한 내)"}
        </span>
        <div className="flex items-center gap-2">
          <Link
            href={hasPrevious ? pageHref(params, page - 1) : currentPath}
            aria-disabled={!hasPrevious}
            className={`focus-ring inline-flex min-h-9 items-center rounded-md border border-rule px-3 text-sm font-semibold ${
              hasPrevious ? "bg-white text-ink/70 hover:bg-parchment" : "pointer-events-none bg-parchment text-ink/35"
            }`}
          >
            이전
          </Link>
          <span className="text-sm font-semibold text-ink/62">{formatNumber(page)}쪽</span>
          <Link
            href={hasNext ? pageHref(params, page + 1) : currentPath}
            aria-disabled={!hasNext}
            className={`focus-ring inline-flex min-h-9 items-center rounded-md border border-rule px-3 text-sm font-semibold ${
              hasNext ? "bg-white text-ink/70 hover:bg-parchment" : "pointer-events-none bg-parchment text-ink/35"
            }`}
          >
            다음
          </Link>
        </div>
      </div>

      {result.items.length === 0 ? (
        <EmptyState title="표시할 URL 후보가 없습니다" description="필터를 조정하거나 다음 수집 실행 이후 다시 확인하세요." />
      ) : (
        <CandidateTable candidates={result.items} csrfToken={csrfToken} returnTo={currentPath} />
      )}
    </div>
  );
}
