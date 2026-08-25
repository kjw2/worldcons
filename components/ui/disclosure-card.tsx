import type { ReactNode } from "react";
import { cn } from "@/lib/utils/classnames";

export function DisclosureCard({
  title,
  meta,
  children,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={cn("border-y border-archive-line bg-archive-surface-soft px-1 py-4 sm:px-3", className)}>
      <summary className="cursor-pointer text-sm font-semibold text-ink">
        {title}
        {meta ? <span className="ml-1 font-medium text-ink-subtle">{meta}</span> : null}
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  );
}
