import Link from "next/link";
import { redirect } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { IngestionStatusPanel } from "@/components/ingestion-status-panel";
import { listIngestionRuns } from "@/lib/db/queries";
import { isAuthorizedPageRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function IngestionRunsPage() {
  const authorized = await isAuthorizedPageRequest();
  if (!authorized) {
    redirect(`/admin/login?next=${encodeURIComponent("/admin/ingestion-runs")}`);
  }

  const runs = await listIngestionRuns(50);
  return (
    <div className="min-w-0 px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-court">System</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink">수집 실행 기록</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink/66">최근 50개 실행의 수집·요약·진단 결과를 확인합니다.</p>
        </div>
        <Link href="/admin/ingestion-runs" className="focus-ring inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink/90">
          <RefreshCw className="size-4" aria-hidden="true" />
          새로고침
        </Link>
      </div>
      <IngestionStatusPanel runs={runs} />
    </div>
  );
}
