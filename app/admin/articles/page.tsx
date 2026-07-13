import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ArrowRight, RefreshCw, Search } from "lucide-react";
import { AdminArticlesTable } from "@/components/admin-articles-table";
import {
  listAdminArticles,
  type AdminArticleListFilters,
  type AdminArticlePublishableFilter,
  type AdminArticleSummaryFilter,
} from "@/lib/db/admin-queries";
import { listSources } from "@/lib/db/queries";
import { displayJurisdictionLabel, displaySourceLabel } from "@/lib/ui/source-labels";
import { createAdminCsrfToken, isAuthorizedPageRequest } from "@/lib/utils/auth";
import { getNumberSearchParam, getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

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

const statusOptions = Object.keys(statusLabels);
const publishableOptions = ["all", "yes", "no"] as const;
const summaryOptions = ["all", "yes", "no"] as const;

function firstText(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseFilters(params: SearchParams): AdminArticleListFilters {
  const publishable = getSearchParam(params, "publishable") as AdminArticlePublishableFilter | undefined;
  const hasSummary = getSearchParam(params, "hasSummary") as AdminArticleSummaryFilter | undefined;
  const pageSize = getNumberSearchParam(params, "pageSize");

  return {
    q: firstText(getSearchParam(params, "q")),
    status: firstText(getSearchParam(params, "status")),
    sourceKey: firstText(getSearchParam(params, "sourceKey")),
    jurisdiction: firstText(getSearchParam(params, "jurisdiction")),
    publishable: publishableOptions.includes(publishable as AdminArticlePublishableFilter) ? publishable : "all",
    hasSummary: summaryOptions.includes(hasSummary as AdminArticleSummaryFilter) ? hasSummary : "all",
    page: getNumberSearchParam(params, "page"),
    pageSize: pageSize ? Math.min(pageSize, 50) : undefined,
  };
}

function searchParamsToString(params: SearchParams) {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) next.append(key, item);
    } else if (value !== undefined) {
      next.set(key, value);
    }
  }
  return next.toString();
}

function pageHref(filters: AdminArticleListFilters, page: number) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.sourceKey) params.set("sourceKey", filters.sourceKey);
  if (filters.jurisdiction) params.set("jurisdiction", filters.jurisdiction);
  if (filters.publishable && filters.publishable !== "all") params.set("publishable", filters.publishable);
  if (filters.hasSummary && filters.hasSummary !== "all") params.set("hasSummary", filters.hasSummary);
  if (filters.pageSize) params.set("pageSize", String(filters.pageSize));
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/admin/articles?${query}` : "/admin/articles";
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

export default async function AdminArticlesPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const params = await resolveSearchParams(searchParams);
  const query = searchParamsToString(params);
  const nextPath = `/admin/articles${query ? `?${query}` : ""}`;
  const authorized = await isAuthorizedPageRequest();
  if (!authorized) {
    redirect(`/admin/login?next=${encodeURIComponent(nextPath)}`);
  }

  const filters = parseFilters(params);
  const [result, sources, csrfToken] = await Promise.all([
    listAdminArticles(filters),
    listSources(),
    createAdminCsrfToken(),
  ]);
  const jurisdictions = Array.from(new Set(sources.map((source) => source.jurisdiction).filter(Boolean))).sort();
  const pageInfo = result.pageInfo;
  const from = pageInfo.total === 0 ? 0 : (pageInfo.page - 1) * pageInfo.pageSize + 1;
  const to = Math.min(pageInfo.page * pageInfo.pageSize, pageInfo.total);

  return (
    <div className="min-w-0 px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-court">Content</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink">기사 관리</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink/66">
            전체 기사 상태와 공개 가능 여부를 필터링하고, 선택한 기사만 제한적으로 일괄 처리합니다.
          </p>
        </div>
        <Link href={pageHref(filters, pageInfo.page)} className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink/90">
          <RefreshCw className="size-4" aria-hidden="true" />
          새로고침
        </Link>
      </div>

      <form action="/admin/articles" className="mb-5 grid gap-3 rounded-md border border-rule bg-white p-4 shadow-sm lg:grid-cols-12">
        <label className="grid gap-1 text-sm font-semibold text-ink/70 lg:col-span-3">
          검색
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink/42" aria-hidden="true" />
            <input name="q" defaultValue={filters.q ?? ""} className="focus-ring h-10 w-full rounded-md border border-rule pl-9 pr-3 font-normal text-ink" />
          </div>
        </label>
        <label className="grid gap-1 text-sm font-semibold text-ink/70 lg:col-span-2">
          status
          <select name="status" defaultValue={filters.status ?? ""} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 font-normal text-ink">
            <option value="">전체</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {statusLabels[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-semibold text-ink/70 lg:col-span-2">
          기관
          <select name="sourceKey" defaultValue={filters.sourceKey ?? ""} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 font-normal text-ink">
            <option value="">전체</option>
            {sources.map((source) => (
              <option key={source.sourceKey} value={source.sourceKey}>
                {displaySourceLabel(source)} · {source.sourceKey}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-semibold text-ink/70 lg:col-span-2">
          국가
          <select name="jurisdiction" defaultValue={filters.jurisdiction ?? ""} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 font-normal text-ink">
            <option value="">전체</option>
            {jurisdictions.map((jurisdiction) => (
              <option key={jurisdiction} value={jurisdiction}>
                {displayJurisdictionLabel(jurisdiction)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-semibold text-ink/70 lg:col-span-1">
          공개 가능
          <select name="publishable" defaultValue={filters.publishable ?? "all"} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 font-normal text-ink">
            <option value="all">전체</option>
            <option value="yes">가능</option>
            <option value="no">불가</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm font-semibold text-ink/70 lg:col-span-1">
          요약
          <select name="hasSummary" defaultValue={filters.hasSummary ?? "all"} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 font-normal text-ink">
            <option value="all">전체</option>
            <option value="yes">있음</option>
            <option value="no">없음</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm font-semibold text-ink/70 lg:col-span-1">
          페이지 크기
          <input name="pageSize" type="number" min={1} max={50} defaultValue={pageInfo.pageSize} className="focus-ring h-10 rounded-md border border-rule px-3 font-normal text-ink" />
        </label>
        <div className="flex items-end gap-2 lg:col-span-12">
          <button type="submit" className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-court px-4 text-sm font-semibold text-white hover:bg-court/90">
            <Search className="size-4" aria-hidden="true" />
            필터 적용
          </button>
          <Link href="/admin/articles" className="focus-ring inline-flex h-10 items-center rounded-md border border-rule bg-white px-4 text-sm font-semibold text-ink/68 hover:bg-parchment">
            초기화
          </Link>
        </div>
      </form>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-white px-4 py-3 text-sm text-ink/64 shadow-sm">
        <span>
          {formatNumber(pageInfo.total)}건 중 {formatNumber(from)}-{formatNumber(to)} 표시
        </span>
        <span>
          페이지 {formatNumber(pageInfo.page)} · {formatNumber(pageInfo.pageSize)}개씩
        </span>
      </div>

      <AdminArticlesTable articles={result.items} csrfToken={csrfToken ?? ""} />

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <Link
          href={pageHref(filters, Math.max(1, pageInfo.page - 1))}
          aria-disabled={pageInfo.page <= 1}
          className={`focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-rule px-4 text-sm font-semibold ${
            pageInfo.page <= 1 ? "pointer-events-none bg-parchment text-ink/35" : "bg-white text-ink/68 hover:bg-parchment"
          }`}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          이전
        </Link>
        <Link
          href={pageHref(filters, pageInfo.page + 1)}
          aria-disabled={!pageInfo.hasMore}
          className={`focus-ring inline-flex h-10 items-center gap-2 rounded-md border border-rule px-4 text-sm font-semibold ${
            pageInfo.hasMore ? "bg-white text-ink/68 hover:bg-parchment" : "pointer-events-none bg-parchment text-ink/35"
          }`}
        >
          다음
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
