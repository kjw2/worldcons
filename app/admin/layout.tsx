import { AdminShell } from "@/components/admin-shell";
import { adminGovernanceUiEnabled, adminRedesignUiEnabled } from "@/lib/admin/p4/flags";
import { createAdminCsrfToken, getAuthorizedAdminPageIdentity } from "@/lib/utils/auth";

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  if (!adminRedesignUiEnabled()) return children;
  const identity = await getAuthorizedAdminPageIdentity();
  if (!identity) return children;
  const csrfToken = (await createAdminCsrfToken()) ?? "";
  return <AdminShell csrfToken={csrfToken} identity={identity} governanceEnabled={adminGovernanceUiEnabled()}>{children}</AdminShell>;
}
