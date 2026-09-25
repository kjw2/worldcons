import { getSupabaseAdmin } from "@/lib/db/client";
import { mockAdminOpsReads } from "@/lib/admin/ops-read-repository/mock-repository";
import { withAdminOpsReadShadow } from "@/lib/admin/ops-read-repository/shadow";
import { createSupabaseAdminOpsReadRepository } from "@/lib/admin/ops-read-repository/supabase-repository";
import type { AdminOpsReadRepository } from "@/lib/admin/ops-read-repository/types";

export * from "@/lib/admin/ops-read-repository/mock-repository";
export * from "@/lib/admin/ops-read-repository/shared";
export * from "@/lib/admin/ops-read-repository/supabase-repository";
export * from "@/lib/admin/ops-read-repository/d1-read-repository";
export * from "@/lib/admin/ops-read-repository/shadow";
export * from "@/lib/admin/ops-read-repository/types";

/**
 * Selection point for the privileged admin/ops read domain. Supabase remains
 * authoritative whenever configuration is present; without it the mock adapter
 * is used, preserving the pre-extraction no-database fallback.
 *
 * When Supabase is authoritative the repository is wrapped with the M6.4
 * `admin_ops_read` shadow. The wrapper is a pure pass-through by default (all
 * shadow flags off) and can only schedule a background bounded D1 read on the
 * `ctx.waitUntil` scheduler, never replace the authoritative result. No-config
 * behavior is unchanged: the mock adapter is returned unwrapped.
 */
export function adminOpsReads(): AdminOpsReadRepository {
  const supabase = getSupabaseAdmin();
  if (!supabase) return mockAdminOpsReads;
  const adminClient = supabase;
  return withAdminOpsReadShadow(createSupabaseAdminOpsReadRepository({ client: () => adminClient }));
}
