import { redirect } from "next/navigation";
import { AdminSourceGrowthDashboard } from "@/components/admin-source-growth-dashboard";
import { getAdminSourceGrowthSnapshot } from "@/lib/admin/source-growth";
import { isAuthorizedPageRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminPage() {
  if (!(await isAuthorizedPageRequest())) {
    redirect(`/admin/login?next=${encodeURIComponent("/admin")}`);
  }

  return <AdminSourceGrowthDashboard snapshot={await getAdminSourceGrowthSnapshot()} />;
}
