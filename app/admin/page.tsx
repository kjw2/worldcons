import Link from "next/link";
import { Play, ShieldAlert } from "lucide-react";
import { IngestionStatusPanel } from "@/components/ingestion-status-panel";
import { listIngestionRuns } from "@/lib/db/queries";
import { isAuthorizedPageRequest } from "@/lib/utils/auth";
import { getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const revalidate = 0;

export default async function AdminPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const params = await resolveSearchParams(searchParams);
  const authorized = await isAuthorizedPageRequest(getSearchParam(params, "secret"));
  const secret = getSearchParam(params, "secret");
  if (!authorized) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="rounded-md border border-court/25 bg-white p-6 text-court">
          <ShieldAlert className="mb-3 size-6" aria-hidden="true" />
          관리자 인증이 필요합니다. Authorization 헤더 또는 ?secret= 값을 사용하세요.
        </div>
      </main>
    );
  }

  const runs = await listIngestionRuns(5);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-sm font-semibold text-court">관리자</p>
          <h1 className="text-3xl font-semibold tracking-normal text-ink">수집 상태</h1>
        </div>
        <Link href={secret ? `/admin/ingestion-runs?secret=${encodeURIComponent(secret)}` : "/admin/ingestion-runs"} className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white">
          <Play className="size-4" aria-hidden="true" />
          실행 기록
        </Link>
      </div>
      <IngestionStatusPanel runs={runs} />
    </main>
  );
}
