import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, LogOut, RefreshCw } from "lucide-react";
import { IngestionStatusPanel } from "@/components/ingestion-status-panel";
import { listIngestionRuns } from "@/lib/db/queries";
import { isAuthorizedPageRequest } from "@/lib/utils/auth";
import { getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function IngestionRunsPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const params = await resolveSearchParams(searchParams);
  const secret = getSearchParam(params, "secret");
  const authorized = await isAuthorizedPageRequest(secret);
  if (!authorized) {
    redirect(`/admin/login?next=${encodeURIComponent(secret ? `/admin/ingestion-runs?secret=${secret}` : "/admin/ingestion-runs")}`);
  }

  const runs = await listIngestionRuns(50);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-sm font-semibold text-court">관리자</p>
          <h1 className="text-3xl font-semibold tracking-normal text-ink">수집 실행 기록</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink/66">최근 50개 실행의 수집·요약·진단 결과를 확인합니다.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={secret ? `/admin?secret=${encodeURIComponent(secret)}` : "/admin"} className="focus-ring inline-flex items-center gap-2 rounded-md border border-rule bg-white px-4 py-2 text-sm font-semibold text-ink/72 hover:bg-parchment">
            <ArrowLeft className="size-4" aria-hidden="true" />
            대시보드
          </Link>
          <Link href={secret ? `/admin/ingestion-runs?secret=${encodeURIComponent(secret)}` : "/admin/ingestion-runs"} className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink/90">
            <RefreshCw className="size-4" aria-hidden="true" />
            새로고침
          </Link>
          <form action="/api/admin/logout" method="post">
            <button type="submit" className="focus-ring inline-flex items-center gap-2 rounded-md border border-rule bg-white px-4 py-2 text-sm font-semibold text-ink/72 hover:bg-parchment">
              <LogOut className="size-4" aria-hidden="true" />
              로그아웃
            </button>
          </form>
        </div>
      </div>
      <IngestionStatusPanel runs={runs} />
    </main>
  );
}
