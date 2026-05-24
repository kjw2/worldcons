import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils/classnames";

type SurfaceCardVariant = "default" | "muted" | "elevated" | "interactive" | "warning";

const variantClassNames: Record<SurfaceCardVariant, string> = {
  default: "border-line bg-surface shadow-card",
  muted: "border-line bg-surface-muted/70",
  elevated: "border-line bg-surface shadow-panel",
  interactive: "border-line bg-surface shadow-card transition hover:border-line-strong hover:shadow-panel",
  warning: "border-court/20 bg-court/5 text-court",
};

export function surfaceCardClassName(variant: SurfaceCardVariant = "default", className?: string) {
  return cn("rounded-lg border", variantClassNames[variant], className);
}

export function SurfaceCard({
  variant = "default",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  variant?: SurfaceCardVariant;
}) {
  return <div className={surfaceCardClassName(variant, className)} {...props} />;
}
