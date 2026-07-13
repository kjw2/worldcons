import { redirect } from "next/navigation";
import { AdminOperationsOverview } from "@/components/admin-operations-overview";
import { getAdminOperationsOverviewSnapshot } from "@/lib/admin/p4/overview";
import { isAuthorizedPageRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminPage() {
  if (!(await isAuthorizedPageRequest())) {
    redirect(`/admin/login?next=${encodeURIComponent("/admin")}`);
  }

  return <AdminOperationsOverview snapshot={await getAdminOperationsOverviewSnapshot()} />;
}
