"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
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
  onRangeChange,
  onRangePrefetch,
}: {
  activeRange: TimeRange;
  basePath?: string;
  paramsString?: string;
  onRangeChange?: (range: TimeRange, href: string) => void;
  onRangePrefetch?: (range: TimeRange) => void;
}) {
  const params = new URLSearchParams(paramsString);

  function handleClick(event: MouseEvent<HTMLAnchorElement>, value: TimeRange, href: string) {
    if (!onRangeChange || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    event.preventDefault();
    onRangeChange(value, href);
  }

  return (
    <div className="inline-flex overflow-x-auto rounded-lg border border-line bg-white p-1 shadow-sm">
      {ranges.map((range) => {
        const href = hrefForRange(range.value, basePath, params);

        return (
          <Link
            key={range.value}
            href={href}
            onClick={(event) => handleClick(event, range.value, href)}
            onMouseEnter={() => onRangePrefetch?.(range.value)}
            onFocus={() => onRangePrefetch?.(range.value)}
            className={cn(
              "focus-ring whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium text-ink-muted transition",
              activeRange === range.value ? "bg-primary text-white" : "hover:bg-surface-muted hover:text-ink",
            )}
          >
            {range.label}
          </Link>
        );
      })}
    </div>
  );
}
