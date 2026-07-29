import type { ReactNode } from "react";
import { cn } from "@/lib/utils/classnames";

export function SectionHeading({
  eyebrow,
  title,
  description,
  actions,
  className,
  descriptionClassName,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  descriptionClassName?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div>
        {eyebrow ? <p className="archive-kicker mb-2">{eyebrow}</p> : null}
        <h2 className="archive-serif text-2xl font-semibold leading-tight text-archive-ink sm:text-3xl">{title}</h2>
        {description ? <p className={cn("mt-3 max-w-3xl text-sm leading-7 text-archive-text sm:text-base", descriptionClassName)}>{description}</p> : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
