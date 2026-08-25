import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils/classnames";

type SurfaceCardVariant = "default" | "muted" | "elevated" | "interactive" | "warning";

const variantClassNames: Record<SurfaceCardVariant, string> = {
  default: "border-archive-line bg-white",
  muted: "border-archive-line bg-archive-surface-soft",
  elevated: "border-archive-line-strong bg-white",
  interactive: "border-archive-line bg-white transition-colors hover:border-archive-line-strong hover:bg-archive-surface-soft",
  warning: "border-court/20 bg-court/5 text-court",
};

export function surfaceCardClassName(variant: SurfaceCardVariant = "default", className?: string) {
  return cn("rounded-sm border", variantClassNames[variant], className);
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
