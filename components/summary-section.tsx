import { cn } from "@/lib/utils/classnames";

type SummarySectionVariant = "primary" | "body" | "insight" | "disclosure" | "raw";

const variantClassNames: Record<SummarySectionVariant, string> = {
  primary: "border-primary/15 bg-primary/[0.03] p-5",
  body: "border-line bg-white p-5",
  insight: "border-gold/25 bg-gold/5 p-5",
  disclosure: "border-line bg-surface-muted/60 p-4",
  raw: "border-line bg-surface-muted/50 p-4",
};

const titleClassNames: Record<SummarySectionVariant, string> = {
  primary: "text-xl",
  body: "text-lg",
  insight: "text-lg",
  disclosure: "text-base",
  raw: "text-base",
};

export function SummarySection({
  title,
  children,
  variant = "body",
  className,
}: {
  title: string;
  children: React.ReactNode;
  variant?: SummarySectionVariant;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border", variantClassNames[variant], className)}>
      <h2 className={cn("mb-3 font-semibold leading-tight tracking-normal text-ink", titleClassNames[variant])}>{title}</h2>
      <div className="text-base leading-8 text-ink-muted">{children}</div>
    </section>
  );
}
