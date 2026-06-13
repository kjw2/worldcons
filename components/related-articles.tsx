import Link from "next/link";
import type { ArticleListItem } from "@/lib/db/types";
import { formattedArticleDate } from "@/lib/ui/article-date-label";

export function RelatedArticles({ articles }: { articles: ArticleListItem[] }) {
  if (articles.length === 0) {
    return <p className="text-sm text-ink-muted">관련 기사가 없습니다.</p>;
  }

  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {articles.map((article) => (
        <li key={article.slug} className="rounded-lg border border-line bg-white p-4">
          <Link href={`/articles/${article.slug}`} className="focus-ring line-clamp-2 rounded-sm font-semibold leading-6 text-ink hover:text-primary">
            {article.koreanTitle || article.originalTitle}
          </Link>
          <p className="mt-2 text-xs text-ink-subtle">
            {article.jurisdiction} · {formattedArticleDate(article, { includeLabel: article.sourceKey === "es-tribunal-constitucional" })}
          </p>
        </li>
      ))}
    </ul>
  );
}
