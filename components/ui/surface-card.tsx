import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils/classnames";

type SurfaceCardVariant = "default" | "muted" | "elevated" | "interactive" | "warning";

const variantClassNames: Record<SurfaceCardVariant, string> = {
  default: "border-[#d5dcd7] bg-white",
  muted: "border-[#d5dcd7] bg-[#f5f7f4]",
  elevated: "border-[#c7d1cb] bg-white shadow-[0_12px_30px_rgba(18,61,50,0.07)]",
  interactive: "border-[#d5dcd7] bg-white transition hover:border-[#8da398] hover:shadow-[0_10px_26px_rgba(18,61,50,0.07)]",
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
