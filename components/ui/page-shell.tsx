import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils/classnames";

export function PageShell({ className, ...props }: ComponentPropsWithoutRef<"main">) {
  return <main className={cn("mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8", className)} {...props} />;
}
