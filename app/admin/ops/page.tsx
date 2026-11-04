import { redirect } from "next/navigation";
import { AdminCollectionStatusTabs } from "@/components/admin-collection-status-tabs";
import { getStagedCollectionSnapshot } from "@/lib/admin/staged-collection-status";
import { listIngestionRuns } from "@/lib/db/queries";
import { listAdminOpsEvents } from "@/lib/ops/watchdog";
import { isAuthorizedPageRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminOpsPage() {
  if (!(await isAuthorizedPageRequest())) {
    redirect(`/admin/login?next=${encodeURIComponent("/admin/ops")}`);
  }

  const [staged, runs, events] = await Promise.all([
    getStagedCollectionSnapshot(),
    listIngestionRuns(30).then((value) => ({ available: true as const, items: value }))
      .catch(() => ({ available: false as const, items: [] })),
    listAdminOpsEvents(20).then((value) => ({ available: true as const, items: value }))
      .catch(() => ({ available: false as const, items: [] })),
  ]);

  return <AdminCollectionStatusTabs staged={staged} runs={runs} events={events} />;
}
