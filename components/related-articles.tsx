import { RelatedArticleLink } from "@/components/article-detail-navigation";
import { RecentDecisionMark } from "@/components/recent-decision-mark";
import type { ArticleListItem } from "@/lib/db/types";
import { formattedArticleDate } from "@/lib/ui/article-date-label";
import { displayJurisdictionLabel } from "@/lib/ui/source-labels";

const relatedArticleClassName = "focus-ring archive-serif line-clamp-2 rounded-sm font-semibold leading-6 text-[#213f35] hover:text-[#2e6552]";

export function RelatedArticles({ articles }: { articles: ArticleListItem[] }) {
  if (articles.length === 0) {
    return <p className="text-sm text-ink-muted">관련 기사가 없습니다.</p>;
  }

  return (
    <ul className="grid border-t border-[#cbd4ce] md:grid-cols-2">
      {articles.map((article) => (
        <li key={article.slug} className="border-b border-[#dce2de] p-4 md:odd:border-r">
          <RelatedArticleLink slug={article.slug} className={relatedArticleClassName}>
            {article.koreanTitle || article.originalTitle}
            <RecentDecisionMark publishedAt={article.originalPublishedAt} />
          </RelatedArticleLink>
          <p className="mt-2 text-xs text-ink-subtle">
            {displayJurisdictionLabel(article.jurisdiction)} · {formattedArticleDate(article, { includeLabel: article.sourceKey === "es-tribunal-constitucional" })}
          </p>
        </li>
      ))}
    </ul>
  );
}
