import { getSupabaseAdmin } from "@/lib/db/client";
import { mockAdminOpsReads } from "@/lib/admin/ops-read-repository/mock-repository";
import { createSupabaseAdminOpsReadRepository } from "@/lib/admin/ops-read-repository/supabase-repository";
import type { AdminOpsReadRepository } from "@/lib/admin/ops-read-repository/types";

export * from "@/lib/admin/ops-read-repository/mock-repository";
export * from "@/lib/admin/ops-read-repository/shared";
export * from "@/lib/admin/ops-read-repository/supabase-repository";
export * from "@/lib/admin/ops-read-repository/types";

/**
 * Selection point for the privileged admin/ops read domain. Supabase remains
 * authoritative whenever configuration is present; without it the mock adapter
 * is used, preserving the pre-extraction no-database fallback.
 */
export function adminOpsReads(): AdminOpsReadRepository {
  const supabase = getSupabaseAdmin();
  if (!supabase) return mockAdminOpsReads;
  const adminClient = supabase;
  return createSupabaseAdminOpsReadRepository({ client: () => adminClient });
}
