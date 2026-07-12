import { AdminShell } from "@/components/admin-shell";
import { adminRedesignUiEnabled } from "@/lib/admin/p4/flags";
import { createAdminCsrfToken } from "@/lib/utils/auth";

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  if (!adminRedesignUiEnabled()) return children;
  const csrfToken = (await createAdminCsrfToken()) ?? "";
  const identity = process.env.ADMIN_USERNAME?.trim() || "administrator";
  return <AdminShell csrfToken={csrfToken} identity={identity}>{children}</AdminShell>;
}
