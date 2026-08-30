import type { ReactNode } from "react";
import { cn } from "@/lib/utils/classnames";

export function SectionHeading({
  title,
  description,
  actions,
  className,
  descriptionClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  descriptionClassName?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div>
        {/* No kicker or label above the title: DESIGN.md derives hierarchy from weight and
            size, and a descriptive Korean title should stand on its own. */}
        <h2 className="archive-serif text-2xl font-semibold leading-tight text-archive-ink sm:text-3xl">{title}</h2>
        {description ? <p className={cn("mt-3 max-w-[72ch] text-sm leading-7 text-archive-text sm:text-base", descriptionClassName)}>{description}</p> : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
