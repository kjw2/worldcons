import { getSupabaseAdmin } from "@/lib/db/client";
import { mockReferenceReads } from "@/lib/reference-reads/mock-repository";
import { withReferenceReadShadow } from "@/lib/reference-reads/shadow";
import { createSupabaseReferenceReadRepository } from "@/lib/reference-reads/supabase-repository";
import type { ReferenceReadRepository } from "@/lib/reference-reads/types";

export * from "@/lib/reference-reads/mock-repository";
export * from "@/lib/reference-reads/shared";
export * from "@/lib/reference-reads/supabase-repository";
export * from "@/lib/reference-reads/types";
export * from "@/lib/reference-reads/d1-repository";
export * from "@/lib/reference-reads/shadow";

/**
 * Selection point for the public reference-read domain. Supabase remains
 * authoritative whenever configuration is present; without it the in-memory
 * mock adapter is used, preserving the pre-extraction fallback.
 *
 * When Supabase is authoritative the repository is wrapped with the M6.1
 * reference-read shadow. The wrapper is a pure pass-through by default (all
 * shadow flags off) and can only schedule a background D1 read, never replace
 * the authoritative result.
 */
export function referenceReads(): ReferenceReadRepository {
  const supabase = getSupabaseAdmin();
  if (!supabase) return mockReferenceReads;
  const adminClient = supabase;
  return withReferenceReadShadow(createSupabaseReferenceReadRepository({ client: () => adminClient }));
}
