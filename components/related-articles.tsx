import { RelatedArticleLink } from "@/components/article-detail-navigation";
import { RecentDecisionMark } from "@/components/recent-decision-mark";
import type { ArticleListItem } from "@/lib/db/types";
import { articleCaseNumber } from "@/lib/ui/article-case-number";
import { formattedArticleDate } from "@/lib/ui/article-date-label";
import { articleTitleForDisplay } from "@/lib/ui/article-title";
import { displayJurisdictionLabel } from "@/lib/ui/source-labels";

const relatedArticleClassName = "focus-ring archive-serif line-clamp-2 rounded-sm font-semibold leading-6 text-archive-heading hover:text-archive-accent-hover";

export function RelatedArticles({ articles }: { articles: ArticleListItem[] }) {
  if (articles.length === 0) {
    return <p className="text-sm text-ink-muted">관련 기사가 없습니다.</p>;
  }

  return (
    <ul className="grid border-t border-archive-line md:grid-cols-2">
      {articles.map((article) => {
        const caseNumber = articleCaseNumber(article);
        return (
          <li key={article.slug} className="border-b border-archive-line p-4 md:odd:border-r">
            <RelatedArticleLink slug={article.slug} className={relatedArticleClassName}>
              {articleTitleForDisplay(article)}
              {caseNumber ? <span className="ml-1 font-sans text-[0.62em] font-medium tracking-normal text-archive-muted align-baseline">({caseNumber})</span> : null}
              <RecentDecisionMark publishedAt={article.originalPublishedAt} />
            </RelatedArticleLink>
            <p className="mt-2 text-xs text-ink-subtle">
              {displayJurisdictionLabel(article.jurisdiction)} · {formattedArticleDate(article, { includeLabel: article.sourceKey === "es-tribunal-constitucional" })}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
