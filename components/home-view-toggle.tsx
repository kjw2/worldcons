"use client";

import Link from "next/link";
import { LayoutGrid, List } from "lucide-react";
import { cn } from "@/lib/utils/classnames";

export type HomeViewMode = "card" | "list";

function hrefForView(paramsString: string, mode: HomeViewMode) {
  const params = new URLSearchParams(paramsString);
  params.delete("page");
  params.delete("pageSize");
  params.delete("view");
  const query = params.toString();
  const basePath = mode === "list" ? "/list" : "/";
  return query ? `${basePath}?${query}` : basePath;
}

export function HomeViewToggle({
  activeView,
  paramsString,
  className,
}: {
  activeView: HomeViewMode;
  paramsString: string;
  className?: string;
}) {
  const options: Array<{ value: HomeViewMode; label: string; icon: typeof LayoutGrid }> = [
    { value: "card", label: "카드형", icon: LayoutGrid },
    { value: "list", label: "리스트형", icon: List },
  ];

  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <p className="text-sm font-semibold text-ink-muted">보기</p>
      <div className="inline-flex rounded-lg border border-line bg-white p-1 shadow-sm">
        {options.map((option) => {
          const Icon = option.icon;
          const isActive = activeView === option.value;

          return (
            <Link
              key={option.value}
              href={hrefForView(paramsString, option.value)}
              className={cn(
                "focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 text-sm font-semibold transition",
                isActive ? "bg-primary text-white" : "text-ink-muted hover:bg-surface-muted hover:text-ink",
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {option.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
