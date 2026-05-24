import type { ReactNode } from "react";
import { cn } from "@/lib/utils/classnames";

export function MetaRow({
  items,
  className,
}: {
  items: ReactNode[];
  className?: string;
}) {
  const visibleItems = items.filter(Boolean);

  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted", className)}>
      {visibleItems.map((item, index) => (
        <span key={index} className="inline-flex items-center gap-2">
          {index > 0 ? <span className="text-ink-subtle" aria-hidden="true">·</span> : null}
          <span>{item}</span>
        </span>
      ))}
    </div>
  );
}
