import { getSupabaseAdmin } from "@/lib/db/client";
import { mockReferenceReads } from "@/lib/reference-reads/mock-repository";
import { createSupabaseReferenceReadRepository } from "@/lib/reference-reads/supabase-repository";
import type { ReferenceReadRepository } from "@/lib/reference-reads/types";

export * from "@/lib/reference-reads/mock-repository";
export * from "@/lib/reference-reads/shared";
export * from "@/lib/reference-reads/supabase-repository";
export * from "@/lib/reference-reads/types";

/**
 * Selection point for the public reference-read domain. Supabase remains
 * authoritative whenever configuration is present; without it the in-memory
 * mock adapter is used, preserving the pre-extraction fallback.
 */
export function referenceReads(): ReferenceReadRepository {
  const supabase = getSupabaseAdmin();
  if (!supabase) return mockReferenceReads;
  const adminClient = supabase;
  return createSupabaseReferenceReadRepository({ client: () => adminClient });
}
