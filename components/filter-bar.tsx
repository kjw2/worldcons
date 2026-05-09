import { Filter } from "lucide-react";
import type { ArticleContentType, SourceRecord, TagSummary } from "@/lib/db/types";
import type { TimeRange } from "@/lib/utils/dates";
import { TimeRangeTabs } from "@/components/time-range-tabs";

const contentTypes: Array<{ value: ArticleContentType; label: string }> = [
  { value: "news", label: "뉴스" },
  { value: "press_release", label: "보도자료" },
  { value: "decision", label: "결정" },
  { value: "opinion", label: "의견" },
  { value: "order", label: "명령" },
  { value: "other", label: "기타" },
];

export function FilterBar({
  activeRange,
  sources,
  tags,
  params,
  basePath = "/",
}: {
  activeRange: TimeRange;
  sources: SourceRecord[];
  tags: TagSummary[];
  params: URLSearchParams;
  basePath?: string;
}) {
  return (
    <div className="space-y-4 rounded-md border border-rule bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TimeRangeTabs activeRange={activeRange} basePath={basePath} params={params} />
        <span className="inline-flex items-center gap-2 text-sm font-medium text-ink/64">
          <Filter className="size-4" aria-hidden="true" />
          서버 기준 필터
        </span>
      </div>
      <form action={basePath} className="grid gap-3 md:grid-cols-5">
        <input type="hidden" name="range" value={activeRange === "latest" ? "" : activeRange} />
        <select name="source" defaultValue={params.get("source") ?? ""} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm">
          <option value="">기관 전체</option>
          {sources.map((source) => (
            <option key={source.sourceKey} value={source.sourceKey}>
              {source.name}
            </option>
          ))}
        </select>
        <select name="jurisdiction" defaultValue={params.get("jurisdiction") ?? ""} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm">
          <option value="">국가 전체</option>
          {[...new Set(sources.map((source) => source.jurisdiction))].map((jurisdiction) => (
            <option key={jurisdiction} value={jurisdiction}>
              {jurisdiction}
            </option>
          ))}
        </select>
        <select name="type" defaultValue={params.get("type") ?? ""} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm">
          <option value="">유형 전체</option>
          {contentTypes.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
        <select name="tag" defaultValue={params.get("tag") ?? ""} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm">
          <option value="">태그 전체</option>
          {tags.slice(0, 30).map((tag) => (
            <option key={tag.slug} value={tag.slug}>
              {tag.name}
            </option>
          ))}
        </select>
        <select name="language" defaultValue={params.get("language") ?? ""} className="focus-ring h-10 rounded-md border border-rule bg-white px-3 text-sm">
          <option value="">언어 전체</option>
          {[...new Set(sources.map((source) => source.language))].map((language) => (
            <option key={language} value={language}>
              {language}
            </option>
          ))}
        </select>
        {params.get("q") ? <input type="hidden" name="q" value={params.get("q") ?? ""} /> : null}
        {params.get("mode") ? <input type="hidden" name="mode" value={params.get("mode") ?? ""} /> : null}
        <button type="submit" className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white transition hover:bg-ink/90 md:col-span-5">
          <Filter className="size-4" aria-hidden="true" />
          필터 적용
        </button>
      </form>
    </div>
  );
}
