import { redirect } from "next/navigation";
import { Layers3 } from "lucide-react";
import { AdminWorkQueue } from "@/components/admin-work-queue";
import { parseAdminWorkFilters } from "@/lib/admin/p4/filters";
import { getAdminWorkQueueSnapshot } from "@/lib/admin/p4/repository";
import { createAdminCsrfToken, isAuthorizedPageRequest } from "@/lib/utils/auth";
import { resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminWorkPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const params = await resolveSearchParams(searchParams);
  const nextQuery = new URLSearchParams(Object.entries(params).flatMap(([key, value]) => Array.isArray(value) ? value.map((item) => [key, item]) : value ? [[key, value]] : [])).toString();
  const nextPath = `/admin/work${nextQuery ? `?${nextQuery}` : ""}`;
  if (!(await isAuthorizedPageRequest())) redirect(`/admin/login?next=${encodeURIComponent(nextPath)}`);

  const filters = parseAdminWorkFilters(params);
  const [snapshot, csrfToken] = await Promise.all([getAdminWorkQueueSnapshot(filters), createAdminCsrfToken()]);

  return (
    <div className="min-w-0 py-6">
      <header className="px-4 pb-5 sm:px-6">
        <div className="flex items-start gap-3">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-rule bg-white text-court"><Layers3 className="size-4" aria-hidden="true" /></span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-court">운영</p>
            <h1 className="mt-1 text-2xl font-semibold text-ink">통합 업무 큐</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/60">실행, 기사 처리 단계, URL 후보, 공개 및 캐시 전달 상태를 하나의 제한된 서버 조회 결과로 확인합니다.</p>
          </div>
        </div>
      </header>
      <AdminWorkQueue snapshot={snapshot} filters={filters} csrfToken={csrfToken ?? ""} />
    </div>
  );
}
