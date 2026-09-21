import { getSupabaseAdmin } from "@/lib/db/client";
import { mockArticleReads } from "@/lib/article-reads/mock-repository";
import { createSupabaseArticleReadRepository } from "@/lib/article-reads/supabase-repository";
import type { ArticleReadRepository } from "@/lib/article-reads/types";

export * from "@/lib/article-reads/mock-repository";
export * from "@/lib/article-reads/shared";
export * from "@/lib/article-reads/supabase-repository";
export * from "@/lib/article-reads/types";

/**
 * Selection point for the public article detail read domain. Supabase remains
 * authoritative whenever configuration is present; without it the in-memory mock
 * adapter is used, preserving the pre-extraction fallback.
 */
export function articleReads(): ArticleReadRepository {
  const supabase = getSupabaseAdmin();
  if (!supabase) return mockArticleReads;
  const adminClient = supabase;
  return createSupabaseArticleReadRepository({ client: () => adminClient });
}
