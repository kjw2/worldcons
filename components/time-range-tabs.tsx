import Link from "next/link";
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
  params,
}: {
  activeRange: TimeRange;
  basePath?: string;
  params?: URLSearchParams;
}) {
  return (
    <div className="inline-flex overflow-x-auto rounded-lg border border-line bg-white p-1 shadow-sm">
      {ranges.map((range) => (
        <Link
          key={range.value}
          href={hrefForRange(range.value, basePath, params)}
          className={cn(
            "focus-ring whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium text-ink-muted transition",
            activeRange === range.value ? "bg-primary text-white" : "hover:bg-surface-muted hover:text-ink",
          )}
        >
          {range.label}
        </Link>
      ))}
    </div>
  );
}
