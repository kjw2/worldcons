import Link from "next/link";
import type { ArticleListItem } from "@/lib/db/types";
import { formatDisplayDate } from "@/lib/utils/dates";

export function RelatedArticles({ articles }: { articles: ArticleListItem[] }) {
  if (articles.length === 0) {
    return <p className="text-sm text-ink/58">관련 기사가 없습니다.</p>;
  }

  return (
    <ul className="divide-y divide-rule rounded-md border border-rule">
      {articles.map((article) => (
        <li key={article.slug} className="p-4">
          <Link href={`/articles/${article.slug}`} className="focus-ring block rounded-sm font-medium text-ink hover:text-court">
            {article.koreanTitle || article.originalTitle}
          </Link>
          <p className="mt-1 text-xs text-ink/55">
            {article.jurisdiction} · {formatDisplayDate(article.originalPublishedAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}
