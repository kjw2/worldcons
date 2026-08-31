import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { createAdminCsrfToken, getAuthorizedAdminPageIdentity, isMasterdashSsoOnly } from "@/lib/utils/auth";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    noarchive: true,
  },
};

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const identity = await getAuthorizedAdminPageIdentity();
  if (!identity) {
    if (isMasterdashSsoOnly()) {
      notFound();
    }
    return children;
  }
  const csrfToken = (await createAdminCsrfToken()) ?? "";
  return <AdminShell csrfToken={csrfToken} identity={identity}>{children}</AdminShell>;
}
