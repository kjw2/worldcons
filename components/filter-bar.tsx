import Link from "next/link";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { SearchBox } from "@/components/search-box";
import type { ArticleContentType, SourceRecord, TagSummary } from "@/lib/db/types";
import type { TimeRange } from "@/lib/utils/dates";
import { TimeRangeTabs } from "@/components/time-range-tabs";
import { chipClassName } from "@/components/ui/chip";
import { SurfaceCard } from "@/components/ui/surface-card";
import { displayContentTypeLabel } from "@/lib/ui/content-type-labels";
import { jurisdictionThemeStyle, themeForJurisdiction } from "@/lib/ui/jurisdiction-theme";
import { displayJurisdictionLabel, displaySourceLabel, displaySourceLanguageLabel } from "@/lib/ui/source-labels";

const contentTypes: Array<{ value: ArticleContentType; label: string }> = [
  { value: "news", label: displayContentTypeLabel("news") },
  { value: "press_release", label: displayContentTypeLabel("press_release") },
  { value: "decision", label: displayContentTypeLabel("decision") },
  { value: "opinion", label: displayContentTypeLabel("opinion") },
  { value: "order", label: displayContentTypeLabel("order") },
  { value: "other", label: displayContentTypeLabel("other") },
];

const selectClassName = "focus-ring h-11 w-full min-w-0 max-w-full truncate rounded-lg border border-line bg-white px-3 text-sm text-ink shadow-sm";

function hrefForJurisdiction(basePath: string, params: URLSearchParams, jurisdiction: string, isActive: boolean) {
  const next = new URLSearchParams(params);
  if (isActive) next.delete("jurisdiction");
  else next.set("jurisdiction", jurisdiction);
  next.delete("source");
  next.delete("page");
  const query = next.toString();
  return query ? `${basePath}?${query}` : basePath;
}

function jurisdictionOptionLabel(jurisdiction: string, counts?: Record<string, number>) {
  const count = counts?.[jurisdiction];
  return count === undefined ? displayJurisdictionLabel(jurisdiction) : `${displayJurisdictionLabel(jurisdiction)} (${count.toLocaleString("ko-KR")})`;
}

export function FilterBar({
  activeRange,
  sources,
  tags,
  paramsString,
  jurisdictionArticleCounts,
  basePath = "/",
  showJurisdictionChips = true,
}: {
  activeRange: TimeRange;
  sources: SourceRecord[];
  tags: TagSummary[];
  paramsString: string;
  jurisdictionArticleCounts?: Record<string, number>;
  basePath?: string;
  showJurisdictionChips?: boolean;
}) {
  const params = new URLSearchParams(paramsString);
  const activeJurisdiction = params.get("jurisdiction") ?? "";
  const jurisdictions = [...new Set(sources.map((source) => source.jurisdiction))];
  const hasAdvancedFilters = Boolean(params.get("source") || params.get("type") || params.get("tag") || params.get("language"));
  const searchHiddenFields = [...params.entries()].filter(([key]) => key !== "q" && key !== "page" && key !== "pageSize");

  return (
    <SurfaceCard className="min-w-0 space-y-4 overflow-hidden p-4">
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <TimeRangeTabs
            activeRange={activeRange}
            basePath={basePath}
            paramsString={paramsString}
          />
          {showJurisdictionChips ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {jurisdictions.map((jurisdiction) => {
                const isActive = activeJurisdiction === jurisdiction;
                const theme = themeForJurisdiction(jurisdiction);
                const count = jurisdictionArticleCounts?.[jurisdiction];
                const countBadgeClassName = isActive
                  ? "rounded-full bg-white/20 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white tabular-nums"
                  : "rounded-full bg-white/75 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-current tabular-nums";

                return (
                  <Link
                    key={jurisdiction}
                    href={hrefForJurisdiction(basePath, params, jurisdiction, isActive)}
                    style={jurisdictionThemeStyle(theme)}
                    className={chipClassName(isActive ? "selected" : "country")}
                  >
                    <span>{displayJurisdictionLabel(jurisdiction)}</span>
                    {count === undefined ? null : (
                      <span className={countBadgeClassName}>
                        {count.toLocaleString("ko-KR")}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
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

      <details className="group min-w-0 overflow-hidden rounded-lg border border-line bg-surface-muted/45" open={hasAdvancedFilters}>
        <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-semibold text-ink marker:hidden">
          <span className="inline-flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-ink-muted" aria-hidden="true" />
            상세 필터
          </span>
          <ChevronDown className="size-4 text-ink-muted transition group-open:rotate-180" aria-hidden="true" />
        </summary>
        <form action={basePath} className="grid min-w-0 grid-cols-1 gap-3 border-t border-line p-3 sm:p-4 md:grid-cols-2 lg:grid-cols-4">
          {activeRange !== "latest" ? <input type="hidden" name="range" value={activeRange} /> : null}
          <select name="source" defaultValue={params.get("source") ?? ""} className={selectClassName}>
            <option value="">기관 전체</option>
            {sources.map((source) => (
              <option key={source.sourceKey} value={source.sourceKey}>
                {displaySourceLabel(source)}
              </option>
            ))}
          </select>
          <select name="jurisdiction" defaultValue={activeJurisdiction} className={selectClassName}>
            <option value="">국가 전체</option>
            {jurisdictions.map((jurisdiction) => (
              <option key={jurisdiction} value={jurisdiction}>
                {jurisdictionOptionLabel(jurisdiction, jurisdictionArticleCounts)}
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
                {displaySourceLanguageLabel(language)}
              </option>
            ))}
          </select>
          {params.get("q") ? <input type="hidden" name="q" value={params.get("q") ?? ""} /> : null}
          {params.get("mode") ? <input type="hidden" name="mode" value={params.get("mode") ?? ""} /> : null}
          <button type="submit" className="focus-ring inline-flex h-11 w-full min-w-0 items-center justify-center gap-2 rounded-lg border border-line bg-white px-4 text-sm font-semibold text-ink transition hover:border-line-strong hover:bg-surface-muted lg:col-span-3">
            적용
          </button>
        </form>
      </details>
    </SurfaceCard>
  );
}
