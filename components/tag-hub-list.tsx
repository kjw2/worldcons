import { Hash } from "lucide-react";
import { TrackedLink } from "@/components/tracked-link";
import type { TagSummary } from "@/lib/db/types";
import { formatDisplayDate } from "@/lib/utils/dates";

export function TagHubList({ tags }: { tags: TagSummary[] }) {
  if (tags.length === 0) {
    return <div className="rounded-md border border-dashed border-rule bg-white px-5 py-12 text-center text-sm text-ink/62">아직 생성된 태그가 없습니다.</div>;
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {tags.map((tag) => (
        <TrackedLink
          key={tag.slug}
          href={`/tags/${tag.slug}`}
          event={{ eventType: "tag_click", tagSlug: tag.slug, tagName: tag.name, metadata: { surface: "tag_hub" } }}
          className="focus-ring rounded-md border border-rule bg-white p-4 shadow-sm transition hover:border-court/45 hover:shadow-soft"
        >
          <div className="flex items-start justify-between gap-3">
            <span className="inline-flex items-center gap-2 font-semibold text-ink">
              <Hash className="size-4 text-court" aria-hidden="true" />
              {tag.name}
            </span>
            <span className="rounded bg-parchment px-2 py-1 text-xs font-medium text-ink/62">{tag.type}</span>
          </div>
          <p className="mt-4 text-sm text-ink/62">누적 기사 {tag.articleCount ?? 0}건</p>
          <p className="mt-1 text-xs text-ink/50">최근 업데이트 {formatDisplayDate(tag.latestArticleAt)}</p>
        </TrackedLink>
      ))}
    </div>
  );
}
