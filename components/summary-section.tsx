import { cn } from "@/lib/utils/classnames";

type SummarySectionVariant = "primary" | "body" | "insight" | "disclosure" | "raw";

const variantClassNames: Record<SummarySectionVariant, string> = {
  primary: "border-[#9fb1a7] bg-[#f4f7f4] py-6",
  body: "border-[#d1d9d4] bg-transparent py-6",
  insight: "border-[#c5d0ca] bg-[#fafbf8] py-6",
  disclosure: "border-[#d1d9d4] bg-[#f6f7f4] py-5",
  raw: "border-[#d1d9d4] bg-[#f6f7f4] py-5",
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
      <h2 className={cn("archive-serif mb-3 font-semibold leading-tight text-[#173d33]", titleClassNames[variant])}>{title}</h2>
      <div className="text-base leading-8 text-[#4f5f59]">{children}</div>
    </section>
  );
}
