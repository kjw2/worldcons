import { cn } from "@/lib/utils/classnames";

type SummarySectionVariant = "primary" | "body" | "insight" | "disclosure" | "raw";

const variantClassNames: Record<SummarySectionVariant, string> = {
  primary: "border-archive-line-strong bg-archive-surface-soft py-6",
  body: "border-archive-line bg-transparent py-6",
  insight: "border-archive-line bg-archive-surface-soft py-6",
  disclosure: "border-archive-line bg-archive-surface-soft py-5",
  raw: "border-archive-line bg-archive-surface-soft py-5",
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
    <section className={cn("border-x-0 border-b-0 border-t px-0 sm:px-1", variantClassNames[variant], className)}>
      <h2 className={cn("archive-serif mb-3 font-semibold leading-tight text-archive-heading", titleClassNames[variant])}>{title}</h2>
      <div className="text-base leading-8 text-archive-text">{children}</div>
    </section>
  );
}
