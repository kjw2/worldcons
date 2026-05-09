export function SummarySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-rule py-6 first:border-t-0 first:pt-0">
      <h2 className="mb-3 text-base font-semibold tracking-normal text-ink">{title}</h2>
      <div className="text-sm leading-7 text-ink/74">{children}</div>
    </section>
  );
}
