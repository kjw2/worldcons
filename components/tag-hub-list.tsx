import { Hash } from "lucide-react";
import { TrackedLink } from "@/components/tracked-link";
import { EmptyState } from "@/components/ui/empty-state";
import { chipClassName } from "@/components/ui/chip";
import { surfaceCardClassName } from "@/components/ui/surface-card";
import type { TagSummary } from "@/lib/db/types";
import { formatDisplayDate } from "@/lib/utils/dates";

export function TagHubList({ tags }: { tags: TagSummary[] }) {
  if (tags.length === 0) {
    return <EmptyState title="아직 생성된 태그가 없습니다" description="자료가 수집되고 요약되면 쟁점, 권리, 조문 태그가 이곳에 정리됩니다." />;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {tags.map((tag) => (
        <TrackedLink
          key={tag.slug}
          href={`/tags/${tag.slug}`}
          event={{ eventType: "tag_click", tagSlug: tag.slug, tagName: tag.name, metadata: { surface: "tag_hub" } }}
          className={surfaceCardClassName("interactive", "focus-ring block min-w-0 p-5")}
        >
          <div className="flex items-start justify-between gap-3">
            <span className="inline-flex min-w-0 items-center gap-2 break-words text-lg font-semibold leading-snug text-ink [overflow-wrap:anywhere]">
              <Hash className="size-4 shrink-0 text-court" aria-hidden="true" />
              {tag.name}
            </span>
            <span className={chipClassName("muted", "min-h-7 px-2 text-xs")}>{tag.type}</span>
          </div>
          <p className="mt-4 text-sm font-semibold text-ink">누적 자료 {(tag.articleCount ?? 0).toLocaleString("ko-KR")}건</p>
          <p className="mt-1 text-xs text-ink-subtle">최근 업데이트 {formatDisplayDate(tag.latestArticleAt)}</p>
        </TrackedLink>
      ))}
    </div>
  );
}
