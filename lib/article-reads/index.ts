import { publicProjectionReadsEnabled } from "@/lib/article-publication";
import { caseCatalogPublicReadsEnabled } from "@/lib/case-catalog/flags";
import { getSupabaseAdmin } from "@/lib/db/client";
import { mockArticleReads } from "@/lib/article-reads/mock-repository";
import { withArticleReadShadow } from "@/lib/article-reads/shadow";
import { createSupabaseArticleReadRepository } from "@/lib/article-reads/supabase-repository";
import type { ArticleReadRepository } from "@/lib/article-reads/types";

export * from "@/lib/article-reads/mock-repository";
export * from "@/lib/article-reads/shared";
export * from "@/lib/article-reads/supabase-repository";
export * from "@/lib/article-reads/types";
export * from "@/lib/article-reads/d1-repository";
export * from "@/lib/article-reads/shadow";

/**
 * Selection point for the public article detail read domain. Supabase remains
 * authoritative whenever configuration is present; without it the in-memory mock
 * adapter is used, preserving the pre-extraction fallback.
 *
 * When Supabase is authoritative the repository is wrapped with the M6.3
 * article-read shadow. The wrapper is a pure pass-through by default (all shadow
 * flags off) and can only schedule a background bounded D1 read, never replace
 * the authoritative result. The projection and case-catalog V4 decisions are
 * injected so the shadow matches the authoritative adapter: those relations are
 * not migrated to D1, so public projection/V4 reads skip.
 */
export function articleReads(): ArticleReadRepository {
  const supabase = getSupabaseAdmin();
  if (!supabase) return mockArticleReads;
  const adminClient = supabase;
  return withArticleReadShadow(createSupabaseArticleReadRepository({ client: () => adminClient }), {
    projection: publicProjectionReadsEnabled(false),
    caseCatalogPublic: caseCatalogPublicReadsEnabled(),
  });
}
