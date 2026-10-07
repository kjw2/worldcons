import { getRuntimeD1Binding } from "@/lib/cloudflare/d1/runtime-binding";
import { createD1ArticleReadRepository } from "@/lib/article-reads/d1-repository";
import { mockArticleReads } from "@/lib/article-reads/mock-repository";
import type { ArticleReadRepository } from "@/lib/article-reads/types";

export * from "@/lib/article-reads/mock-repository";
export * from "@/lib/article-reads/shared";
export * from "@/lib/article-reads/types";
export * from "@/lib/article-reads/d1-repository";

/**
 * Cloudflare D1 is the only persistent public article-read authority. Local
 * environments without the runtime binding use the in-memory fixture adapter.
 */
export function articleReads(): ArticleReadRepository {
  const binding = getRuntimeD1Binding("worldcons_core");
  return binding ? createD1ArticleReadRepository({ binding, maxRows: 10_000 }) : mockArticleReads;
}
