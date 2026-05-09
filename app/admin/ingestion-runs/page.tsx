import { ShieldAlert } from "lucide-react";
import { IngestionStatusPanel } from "@/components/ingestion-status-panel";
import { listIngestionRuns } from "@/lib/db/queries";
import { isAuthorizedPageRequest } from "@/lib/utils/auth";
import { getSearchParam, resolveSearchParams, type SearchParams } from "@/lib/utils/search-params";

export const revalidate = 0;

export default async function IngestionRunsPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const params = await resolveSearchParams(searchParams);
  const authorized = await isAuthorizedPageRequest(getSearchParam(params, "secret"));
  if (!authorized) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="rounded-md border border-court/25 bg-white p-6 text-court">
          <ShieldAlert className="mb-3 size-6" aria-hidden="true" />
          관리자 인증이 필요합니다.
        </div>
      </main>
    );
  }

  const runs = await listIngestionRuns(50);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <p className="mb-2 text-sm font-semibold text-court">관리자</p>
        <h1 className="text-3xl font-semibold tracking-normal text-ink">Ingestion Runs</h1>
      </div>
      <IngestionStatusPanel runs={runs} />
    </main>
  );
}
