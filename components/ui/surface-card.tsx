import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils/classnames";

type SurfaceCardVariant = "default" | "muted" | "elevated" | "interactive" | "warning";

const variantClassNames: Record<SurfaceCardVariant, string> = {
  default: "border-archive-line bg-white",
  muted: "border-archive-line bg-archive-surface",
  elevated: "border-archive-line bg-white shadow-[0_12px_30px_rgba(32,36,43,0.08)]",
  interactive: "border-archive-line bg-white transition hover:border-archive-accent hover:shadow-[0_10px_26px_rgba(32,36,43,0.08)]",
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
