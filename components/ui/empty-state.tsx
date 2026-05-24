import type { ReactNode } from "react";
import { SurfaceCard } from "@/components/ui/surface-card";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <SurfaceCard variant="muted" className="px-5 py-12 text-center">
      <p className="text-base font-semibold text-ink">{title}</p>
      {description ? <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-ink-muted">{description}</p> : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </SurfaceCard>
  );
}
