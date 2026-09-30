import { notFound, redirect } from "next/navigation";
import { AdminWorkDetail } from "@/components/admin-work-detail";
import { getD1AdminWorkItemDetail } from "@/lib/admin/p4/d1-repository";
import { ADMIN_WORK_TYPES, type AdminWorkType } from "@/lib/admin/p4/types";
import { createAdminCsrfToken, isAuthorizedPageRequest } from "@/lib/utils/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminWorkDetailPage({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await params;
  const nextPath = `/admin/work/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
  if (!(await isAuthorizedPageRequest())) redirect(`/admin/login?next=${encodeURIComponent(nextPath)}`);
  if (!ADMIN_WORK_TYPES.includes(kind as AdminWorkType) || !/^[A-Za-z0-9-]{1,120}$/.test(id)) notFound();

  const [detail, csrfToken] = await Promise.all([getD1AdminWorkItemDetail(kind as AdminWorkType, id), createAdminCsrfToken()]);
  if (!detail) notFound();
  return <AdminWorkDetail detail={detail} csrfToken={csrfToken ?? ""} />;
}
