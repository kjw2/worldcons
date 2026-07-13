import { PageShell } from "@/components/ui/page-shell";
import { SurfaceCard } from "@/components/ui/surface-card";

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-sm bg-[#e7ebe8] ${className}`} />;
}

function SummarySkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <section className="border-t border-[#9bad9f] py-5 first:border-t-0 first:pt-0">
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
    <SurfaceCard className="p-5 sm:p-6">
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
      <SkeletonBlock className="mt-5 h-10 w-full" />
    </SurfaceCard>
  );
}

export default function ArticleLoading() {
  return (
    <PageShell className="max-w-7xl">
      <div aria-busy="true" aria-live="polite">
        <span className="sr-only">자료를 불러오는 중입니다.</span>
        <div className="mb-7 flex gap-2">
          <SkeletonBlock className="h-4 w-10" />
          <SkeletonBlock className="h-4 w-20" />
          <SkeletonBlock className="h-4 w-28" />
        </div>
        <section className="mb-8 border-b border-[#8fa197] pb-7">
          <div className="flex flex-wrap gap-2">
            <SkeletonBlock className="h-5 w-16" />
            <SkeletonBlock className="h-5 w-32" />
            <SkeletonBlock className="h-5 w-24" />
            <SkeletonBlock className="h-5 w-12" />
          </div>
          <div className="mt-4 space-y-3">
            <SkeletonBlock className="h-11 w-full max-w-4xl" />
            <SkeletonBlock className="h-11 w-9/12 max-w-3xl" />
          </div>
          <div className="mt-4 space-y-2">
            <SkeletonBlock className="h-5 w-full max-w-3xl" />
            <SkeletonBlock className="h-5 w-8/12 max-w-2xl" />
          </div>
          <SkeletonBlock className="mt-3 h-4 w-full max-w-2xl" />
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <SkeletonBlock className="h-10 w-28" />
            <SkeletonBlock className="h-10 w-28" />
            <SkeletonBlock className="h-10 w-24" />
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
          <article className="space-y-5">
            <SummarySkeleton lines={4} />
            <SummarySkeleton lines={4} />
            <SummarySkeleton lines={3} />
            <div className="grid gap-5 md:grid-cols-2">
              <SummarySkeleton lines={4} />
              <SummarySkeleton lines={4} />
            </div>
            <SummarySkeleton lines={2} />
            <section className="border-t border-[#9bad9f] py-5">
              <SkeletonBlock className="h-5 w-36" />
              <div className="mt-4 space-y-2 border border-[#d1d9d4] bg-white p-4">
                {Array.from({ length: 8 }).map((_, index) => (
                  <SkeletonBlock key={index} className={index === 7 ? "h-4 w-7/12" : "h-4 w-full"} />
                ))}
              </div>
            </section>
            <SummarySkeleton lines={2} />
          </article>

          <aside className="space-y-4 lg:sticky lg:top-[calc(var(--chrome-header-height)+1rem)]">
            <AsideCardSkeleton blocks={4} />
            <AsideCardSkeleton blocks={3} />
            <SurfaceCard className="p-5">
              <SkeletonBlock className="h-5 w-16" />
              <div className="mt-4 flex flex-wrap gap-2">
                {Array.from({ length: 6 }).map((_, index) => (
                  <SkeletonBlock key={index} className="h-8 w-20" />
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
