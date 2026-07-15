import Link from "next/link";
import type { ArticleListItem } from "@/lib/db/types";
import { articleHrefWithReturnTo } from "@/lib/navigation/article-return";
import { formattedArticleDate } from "@/lib/ui/article-date-label";
import { displayJurisdictionLabel } from "@/lib/ui/source-labels";

export function RelatedArticles({ articles, returnTo }: { articles: ArticleListItem[]; returnTo?: string | null }) {
  if (articles.length === 0) {
    return <p className="text-sm text-ink-muted">관련 기사가 없습니다.</p>;
  }

  return (
    <ul className="grid border-t border-[#cbd4ce] md:grid-cols-2">
      {articles.map((article) => (
        <li key={article.slug} className="border-b border-[#dce2de] p-4 md:odd:border-r">
          <Link href={articleHrefWithReturnTo(article.slug, returnTo)} prefetch={false} className="focus-ring archive-serif line-clamp-2 rounded-sm font-semibold leading-6 text-[#213f35] hover:text-[#2e6552]">
            {article.koreanTitle || article.originalTitle}
          </Link>
          <p className="mt-2 text-xs text-ink-subtle">
            {displayJurisdictionLabel(article.jurisdiction)} · {formattedArticleDate(article, { includeLabel: article.sourceKey === "es-tribunal-constitucional" })}
          </p>
        </li>
      ))}
    </ul>
  );
}
