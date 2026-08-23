import type { Metadata } from "next";
import { AdminShell } from "@/components/admin-shell";
import { createAdminCsrfToken, getAuthorizedAdminPageIdentity } from "@/lib/utils/auth";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    noarchive: true,
  },
};

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const identity = await getAuthorizedAdminPageIdentity();
  if (!identity) return children;
  const csrfToken = (await createAdminCsrfToken()) ?? "";
  return <AdminShell csrfToken={csrfToken} identity={identity}>{children}</AdminShell>;
}
