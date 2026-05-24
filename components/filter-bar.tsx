import Link from "next/link";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { SearchBox } from "@/components/search-box";
import type { ArticleContentType, SourceRecord, TagSummary } from "@/lib/db/types";
import type { TimeRange } from "@/lib/utils/dates";
import { TimeRangeTabs } from "@/components/time-range-tabs";
import { chipClassName } from "@/components/ui/chip";
import { SurfaceCard } from "@/components/ui/surface-card";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";

const contentTypes: Array<{ value: ArticleContentType; label: string }> = [
  { value: "news", label: "뉴스" },
  { value: "press_release", label: "보도자료" },
  { value: "decision", label: "결정" },
  { value: "opinion", label: "의견" },
  { value: "order", label: "명령" },
  { value: "other", label: "기타" },
];

const jurisdictionLabels: Record<string, string> = {
  "United States": "미국",
  Germany: "독일",
  France: "프랑스",
};

const selectClassName = "focus-ring h-11 rounded-lg border border-line bg-white px-3 text-sm text-ink shadow-sm";

function hrefForJurisdiction(basePath: string, params: URLSearchParams, jurisdiction: string, isActive: boolean) {
  const next = new URLSearchParams(params);
  if (isActive) next.delete("jurisdiction");
  else next.set("jurisdiction", jurisdiction);
  next.delete("source");
  next.delete("page");
  const query = next.toString();
  return query ? `${basePath}?${query}` : basePath;
}

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
  const activeJurisdiction = params.get("jurisdiction") ?? "";
  const jurisdictions = [...new Set(sources.map((source) => source.jurisdiction))];
  const hasAdvancedFilters = Boolean(params.get("source") || params.get("type") || params.get("tag") || params.get("language"));
  const hasAnyFilters = Boolean(
    activeRange !== "latest" ||
      params.get("source") ||
      params.get("jurisdiction") ||
      params.get("type") ||
      params.get("tag") ||
      params.get("language"),
  );
  const resetParams = new URLSearchParams();
  if (params.get("q")) resetParams.set("q", params.get("q") ?? "");
  if (params.get("mode")) resetParams.set("mode", params.get("mode") ?? "");
  const resetHref = resetParams.toString() ? `${basePath}?${resetParams.toString()}` : basePath;
  const searchHiddenFields = [...params.entries()].filter(([key]) => key !== "q" && key !== "page" && key !== "pageSize");

  return (
    <SurfaceCard className="space-y-4 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <TimeRangeTabs activeRange={activeRange} basePath={basePath} params={params} />
          <div className="flex flex-wrap items-center gap-2">
            {jurisdictions.map((jurisdiction) => {
              const isActive = activeJurisdiction === jurisdiction;
              const theme = themeForJurisdiction(jurisdiction);

              return (
                <Link
                  key={jurisdiction}
                  href={hrefForJurisdiction(basePath, params, jurisdiction, isActive)}
                  style={jurisdictionThemeStyle(theme)}
                  className={chipClassName(isActive ? "selected" : "country")}
                >
                  {jurisdictionLabels[jurisdiction] ?? jurisdiction}
                </Link>
              );
            })}
          </div>
          {hasAnyFilters ? (
            <Link href={resetHref} className={chipClassName("muted")}>
              초기화
            </Link>
          ) : null}
        </div>
        <div className="w-full lg:max-w-md">
          <SearchBox
            defaultValue={params.get("q") ?? ""}
            action={basePath}
            placeholder="검색어를 입력하세요"
            variant="compact"
            hiddenFields={searchHiddenFields}
          />
        </div>
      </div>

      <details className="group rounded-lg border border-line bg-surface-muted/45" open={hasAdvancedFilters}>
        <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-semibold text-ink marker:hidden">
          <span className="inline-flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-ink-muted" aria-hidden="true" />
            상세 필터
          </span>
          <ChevronDown className="size-4 text-ink-muted transition group-open:rotate-180" aria-hidden="true" />
        </summary>
        <form action={basePath} className="grid gap-3 border-t border-line p-4 md:grid-cols-2 lg:grid-cols-4">
          {activeRange !== "latest" ? <input type="hidden" name="range" value={activeRange} /> : null}
          <select name="source" defaultValue={params.get("source") ?? ""} className={selectClassName}>
            <option value="">기관 전체</option>
            {sources.map((source) => (
              <option key={source.sourceKey} value={source.sourceKey}>
                {source.name}
              </option>
            ))}
          </select>
          <select name="jurisdiction" defaultValue={activeJurisdiction} className={selectClassName}>
            <option value="">국가 전체</option>
            {jurisdictions.map((jurisdiction) => (
              <option key={jurisdiction} value={jurisdiction}>
                {jurisdictionLabels[jurisdiction] ?? jurisdiction}
              </option>
            ))}
          </select>
          <select name="type" defaultValue={params.get("type") ?? ""} className={selectClassName}>
            <option value="">유형 전체</option>
            {contentTypes.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
          <select name="tag" defaultValue={params.get("tag") ?? ""} className={selectClassName}>
            <option value="">태그 전체</option>
            {tags.slice(0, 30).map((tag) => (
              <option key={tag.slug} value={tag.slug}>
                {tag.name}
              </option>
            ))}
          </select>
          <select name="language" defaultValue={params.get("language") ?? ""} className={selectClassName}>
            <option value="">언어 전체</option>
            {[...new Set(sources.map((source) => source.language))].map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </select>
          {params.get("q") ? <input type="hidden" name="q" value={params.get("q") ?? ""} /> : null}
          {params.get("mode") ? <input type="hidden" name="mode" value={params.get("mode") ?? ""} /> : null}
          <button type="submit" className="focus-ring inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-line bg-white px-4 text-sm font-semibold text-ink transition hover:border-line-strong hover:bg-surface-muted lg:col-span-3">
            적용
          </button>
        </form>
      </details>
    </SurfaceCard>
  );
}
