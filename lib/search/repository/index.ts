import { getSupabaseAdmin } from "@/lib/db/client";
import { failClosedSearchRepository } from "@/lib/search/repository/fail-closed-repository";
import { createSupabaseSearchRepository } from "@/lib/search/repository/supabase-repository";
import type { SearchRepository } from "@/lib/search/repository/types";

export * from "@/lib/search/repository/fail-closed-repository";
export * from "@/lib/search/repository/supabase-repository";
export * from "@/lib/search/repository/types";

/**
 * Selection point for the search data-access seam. Supabase remains
 * authoritative whenever configuration is present; without it the fail-closed
 * adapter is used, preserving the pre-extraction no-config behavior.
 */
export function searchRepository(): SearchRepository {
  const supabase = getSupabaseAdmin();
  if (!supabase) return failClosedSearchRepository;
  const adminClient = supabase;
  return createSupabaseSearchRepository({ client: () => adminClient });
}
