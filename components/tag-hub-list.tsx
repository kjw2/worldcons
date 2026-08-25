import { TrackedLink } from "@/components/tracked-link";
import { EmptyState } from "@/components/ui/empty-state";
import type { TagSummary } from "@/lib/db/types";
import { formatDisplayDate } from "@/lib/utils/dates";

const TYPE_LABELS: Record<string, string> = {
  right: "기본권",
  topic: "쟁점",
  doctrine: "헌법원칙",
  procedure: "절차",
  provision: "조문",
};

export function TagHubList({ tags }: { tags: TagSummary[] }) {
  if (tags.length === 0) {
    return <EmptyState title="아직 생성된 헌법 쟁점이 없습니다" description="자료가 수집되고 정리되면 권리, 쟁점, 원칙, 절차별 색인이 이곳에 표시됩니다." />;
  }

  const grouped = tags.reduce<Record<string, TagSummary[]>>((acc, tag) => {
    const key = TYPE_LABELS[tag.type] ?? "기타";
    (acc[key] ??= []).push(tag);
    return acc;
  }, {});

  return (
    <div className="space-y-10">
      {Object.entries(grouped).map(([group, items]) => (
        <section key={group} aria-labelledby={`tag-group-${group}`}>
          <div className="border-y border-archive-line-strong py-3">
            <h2 id={`tag-group-${group}`} className="text-xl font-bold text-archive-ink">{group}</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3">
            {items.map((tag) => (
              <TrackedLink
                key={tag.slug}
                href={`/tags/${tag.slug}`}
                event={{ eventType: "tag_click", tagSlug: tag.slug, tagName: tag.name, metadata: { surface: "tag_hub" } }}
                className="focus-ring flex min-h-[76px] min-w-0 items-center justify-between gap-4 border-b border-archive-line px-2 py-4 hover:bg-archive-surface-soft sm:px-3"
              >
                <span className="min-w-0">
                  <span className="block break-words text-[16px] font-bold leading-6 text-archive-heading [overflow-wrap:anywhere]">{tag.name}</span>
                  <span className="mt-1 block text-xs text-archive-muted">최근 업데이트 {formatDisplayDate(tag.latestArticleAt)}</span>
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-archive-muted">{(tag.articleCount ?? 0).toLocaleString("ko-KR")}</span>
              </TrackedLink>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
