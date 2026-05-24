import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils/classnames";

type ChipVariant = "default" | "selected" | "country" | "tag" | "muted";

const variantClassNames: Record<ChipVariant, string> = {
  default: "border-line bg-surface text-ink-muted hover:border-line-strong hover:text-ink",
  selected: "border-primary bg-primary text-white",
  country: "border-[color:var(--country-border)] bg-[color:var(--country-accent-softer)] text-[color:var(--country-text)] hover:bg-[color:var(--country-accent-soft)]",
  tag: "border-line bg-surface-muted/70 text-ink-muted hover:border-line-strong hover:text-ink",
  muted: "border-line bg-surface-muted/70 text-ink-muted",
};

export function chipClassName(variant: ChipVariant = "default", className?: string) {
  return cn(
    "focus-ring inline-flex min-h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition",
    variantClassNames[variant],
    className,
  );
}

export function Chip({
  variant = "default",
  className,
  ...props
}: ComponentPropsWithoutRef<"span"> & {
  variant?: ChipVariant;
}) {
  return <span className={chipClassName(variant, className)} {...props} />;
}
