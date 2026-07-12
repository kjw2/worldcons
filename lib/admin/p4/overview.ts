import { getAdminDashboardData } from "@/lib/db/admin-queries";
import { DEFAULT_ADMIN_WORK_FILTERS } from "@/lib/admin/p4/filters";
import { getAdminWorkQueueSnapshot } from "@/lib/admin/p4/repository";

export async function getAdminOperationsOverviewSnapshot() {
  const [dashboard, work] = await Promise.all([
    getAdminDashboardData(),
    getAdminWorkQueueSnapshot({ ...DEFAULT_ADMIN_WORK_FILTERS, pageSize: 50 }),
  ]);
  return { generatedAt: new Date().toISOString(), dashboard, work };
}

export type AdminOperationsOverviewSnapshot = Awaited<ReturnType<typeof getAdminOperationsOverviewSnapshot>>;
