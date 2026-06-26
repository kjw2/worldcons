import { PageShell } from "@/components/ui/page-shell";
import { SurfaceCard } from "@/components/ui/surface-card";

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-surface-muted ${className}`} />;
}

function SummarySkeleton({ variant = "body", lines = 3 }: { variant?: "primary" | "body" | "insight" | "muted"; lines?: number }) {
  const variantClassName =
    variant === "primary"
      ? "border-primary/15 bg-primary/[0.03] p-5"
      : variant === "insight"
        ? "border-gold/25 bg-gold/5 p-5"
        : variant === "muted"
          ? "border-line bg-surface-muted/60 p-4"
          : "border-line bg-white p-5";

  return (
    <section className={`rounded-lg border ${variantClassName}`}>
      <SkeletonBlock className="mb-4 h-6 w-28" />
      <div className="space-y-3">
        {Array.from({ length: lines }).map((_, index) => (
          <SkeletonBlock key={index} className={index === lines - 1 ? "h-4 w-8/12" : "h-4 w-full"} />
        ))}
      </div>
    </section>
  );
}

function AsideCardSkeleton({ blocks = 3 }: { blocks?: number }) {
  return (
    <SurfaceCard className="p-5">
      <SkeletonBlock className="h-5 w-24" />
      <div className="mt-4 space-y-4">
        {Array.from({ length: blocks }).map((_, index) => (
          <div key={index} className="flex gap-3">
            <SkeletonBlock className="mt-0.5 size-4 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <SkeletonBlock className="h-4 w-20" />
              <SkeletonBlock className="h-4 w-10/12" />
            </div>
          </div>
        ))}
      </div>
      <SkeletonBlock className="mt-5 h-11 w-full rounded-lg" />
    </SurfaceCard>
  );
}

export default function ArticleLoading() {
  return (
    <PageShell className="max-w-7xl">
      <div aria-busy="true" aria-live="polite">
        <span className="sr-only">자료를 불러오는 중입니다.</span>
        <section className="mb-7 border-b border-line pb-7">
          <div className="flex flex-wrap gap-2">
            <SkeletonBlock className="h-5 w-16" />
            <SkeletonBlock className="h-5 w-32" />
            <SkeletonBlock className="h-5 w-24" />
            <SkeletonBlock className="h-5 w-12" />
          </div>
          <div className="mt-4 space-y-3">
            <SkeletonBlock className="h-9 w-full max-w-4xl" />
            <SkeletonBlock className="h-9 w-9/12 max-w-3xl" />
          </div>
          <div className="mt-4 space-y-2">
            <SkeletonBlock className="h-5 w-full max-w-3xl" />
            <SkeletonBlock className="h-5 w-8/12 max-w-2xl" />
          </div>
          <SkeletonBlock className="mt-3 h-4 w-full max-w-2xl" />
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <SkeletonBlock className="h-11 w-28 rounded-lg" />
            <SkeletonBlock className="h-11 w-28 rounded-lg" />
            <SkeletonBlock className="h-11 w-24 rounded-lg" />
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
          <article className="space-y-5">
            <SummarySkeleton variant="primary" lines={4} />
            <SummarySkeleton lines={4} />
            <SummarySkeleton lines={3} />
            <div className="grid gap-5 md:grid-cols-2">
              <SummarySkeleton variant="insight" lines={4} />
              <SummarySkeleton variant="insight" lines={4} />
            </div>
            <SummarySkeleton variant="muted" lines={2} />
            <section className="rounded-lg border border-line bg-surface-muted/50 p-4">
              <SkeletonBlock className="h-5 w-36" />
              <div className="mt-4 space-y-2 rounded-lg bg-white p-4">
                {Array.from({ length: 8 }).map((_, index) => (
                  <SkeletonBlock key={index} className={index === 7 ? "h-4 w-7/12" : "h-4 w-full"} />
                ))}
              </div>
            </section>
            <SummarySkeleton lines={2} />
          </article>

          <aside className="space-y-4 lg:sticky lg:top-28">
            <AsideCardSkeleton blocks={4} />
            <AsideCardSkeleton blocks={3} />
            <SurfaceCard className="p-5">
              <SkeletonBlock className="h-5 w-16" />
              <div className="mt-4 flex flex-wrap gap-2">
                {Array.from({ length: 6 }).map((_, index) => (
                  <SkeletonBlock key={index} className="h-8 w-20 rounded-full" />
                ))}
              </div>
            </SurfaceCard>
            <SurfaceCard variant="muted" className="p-5">
              <SkeletonBlock className="h-5 w-24" />
              <div className="mt-3 space-y-2">
                <SkeletonBlock className="h-4 w-full" />
                <SkeletonBlock className="h-4 w-10/12" />
                <SkeletonBlock className="h-4 w-8/12" />
              </div>
            </SurfaceCard>
          </aside>
        </div>
      </div>
    </PageShell>
  );
}
