import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { cn } from "@/lib/utils/classnames";
import type { TimeRange } from "@/lib/utils/dates";

const ranges: Array<{ value: TimeRange; label: string }> = [
  { value: "latest", label: "전체" },
  { value: "today", label: "오늘" },
  { value: "week", label: "이번 주" },
  { value: "month", label: "이번 달" },
];

function hrefForRange(value: TimeRange, basePath: string, params?: URLSearchParams) {
  const next = new URLSearchParams(params);
  if (value === "latest") next.delete("range");
  else next.set("range", value);
  next.delete("page");
  const query = next.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export function TimeRangeTabs({
  activeRange,
  basePath = "/",
  paramsString,
}: {
  activeRange: TimeRange;
  basePath?: string;
  paramsString?: string;
}) {
  const params = new URLSearchParams(paramsString);

  return (
    <div className="inline-flex overflow-x-auto border-b border-[#bcc8c1] bg-white">
      {ranges.map((range) => {
        const href = hrefForRange(range.value, basePath, params);

        return (
          <IntentPrefetchLink
            key={range.value}
            href={href}
            className={cn(
              "focus-ring relative whitespace-nowrap px-3 py-2 text-sm font-semibold text-[#697670] transition",
              activeRange === range.value ? "text-[#123d32] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[#123d32]" : "hover:bg-[#f3f6f4] hover:text-[#123d32]",
            )}
          >
            {range.label}
          </IntentPrefetchLink>
        );
      })}
    </div>
  );
}
