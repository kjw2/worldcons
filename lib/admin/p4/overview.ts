import { getAdminDashboardData } from "@/lib/db/admin-queries";
import { DEFAULT_ADMIN_WORK_FILTERS } from "@/lib/admin/p4/filters";
import { getD1AdminWorkQueueSnapshot } from "@/lib/admin/p4/d1-repository";

export async function getAdminOperationsOverviewSnapshot() {
  const [dashboard, work] = await Promise.all([
    getAdminDashboardData(),
    getD1AdminWorkQueueSnapshot({ ...DEFAULT_ADMIN_WORK_FILTERS, pageSize: 50 }),
  ]);
  return { generatedAt: new Date().toISOString(), dashboard, work };
}

export type AdminOperationsOverviewSnapshot = Awaited<ReturnType<typeof getAdminOperationsOverviewSnapshot>>;
