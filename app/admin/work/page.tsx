import { redirect } from "next/navigation";
import { Layers3 } from "lucide-react";
import { AdminWorkQueue } from "@/components/admin-work-queue";
import { parseAdminWorkFilters } from "@/lib/admin/p4/filters";
import { adminRedesignUiEnabled } from "@/lib/admin/p4/flags";
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
  if (!adminRedesignUiEnabled()) redirect("/admin/jobs");

  const filters = parseAdminWorkFilters(params);
  const [snapshot, csrfToken] = await Promise.all([getAdminWorkQueueSnapshot(filters), createAdminCsrfToken()]);

  return (
    <div className="min-w-0 py-6">
      <header className="px-4 pb-5 sm:px-6">
        <div className="flex items-start gap-3">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-rule bg-white text-court"><Layers3 className="size-4" aria-hidden="true" /></span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-court">Operations</p>
            <h1 className="mt-1 text-2xl font-semibold text-ink">Unified work queue</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-ink/60">Execution, article lifecycle, candidate, publication, and outbox attention in one bounded server snapshot.</p>
          </div>
        </div>
      </header>
      <AdminWorkQueue snapshot={snapshot} filters={filters} csrfToken={csrfToken ?? ""} />
    </div>
  );
}
