import type { ArticleListItem } from "@/lib/db/types";
import { ArticleCard } from "@/components/article-card";

export function ArticleGrid({ articles }: { articles: ArticleListItem[] }) {
  if (articles.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-rule bg-white px-5 py-12 text-center text-sm text-ink/62">
        아직 수집된 기사가 없습니다.
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {articles.map((article) => (
        <ArticleCard key={article.slug} article={article} />
      ))}
    </div>
  );
}
