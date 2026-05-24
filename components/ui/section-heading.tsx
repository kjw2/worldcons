import type { ReactNode } from "react";
import { cn } from "@/lib/utils/classnames";

export function SectionHeading({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div>
        {eyebrow ? <p className="mb-2 text-sm font-semibold text-court">{eyebrow}</p> : null}
        <h2 className="text-2xl font-semibold leading-tight tracking-normal text-ink sm:text-3xl">{title}</h2>
        {description ? <p className="mt-3 max-w-3xl text-base leading-7 text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
