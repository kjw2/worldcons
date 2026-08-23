import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils/classnames";

export function PageShell({ className, ...props }: ComponentPropsWithoutRef<"main">) {
  return <main className={cn("public-information-page mx-auto max-w-[1480px] px-4 py-8 sm:px-6 sm:py-10 lg:px-10", className)} {...props} />;
}
