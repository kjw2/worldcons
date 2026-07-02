"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FilterBar } from "@/components/filter-bar";
import { InfiniteArticleFeed } from "@/components/infinite-article-feed";
import { SurfaceCard } from "@/components/ui/surface-card";
import type { ArticleListResult, SourceRecord, TagSummary } from "@/lib/db/types";
import { normalizeRange, type TimeRange } from "@/lib/utils/dates";

interface HomeRangePayload {
  articles: ArticleListResult;
  jurisdictionArticleCounts: Record<string, number>;
}

interface HomeFeedPanelProps {
  initialResult: ArticleListResult;
  initialRange: TimeRange;
  initialParamsString: string;
  sources: SourceRecord[];
  tags: TagSummary[];
  jurisdictionArticleCounts: Record<string, number>;
  pageSize?: number;
}

function paramsStringForRange(paramsString: string, range: TimeRange) {
  const params = new URLSearchParams(paramsString);
  if (range === "latest") params.delete("range");
  else params.set("range", range);
  params.delete("page");
  params.delete("pageSize");
  return params.toString();
}

function hrefForParams(paramsString: string) {
  return paramsString ? `/?${paramsString}` : "/";
}

function currentHomeParamsString() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  params.delete("page");
  params.delete("pageSize");
  return params.toString();
}

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-surface-muted ${className}`} />;
}

function ArticleCardSkeleton() {
  return (
    <div className="flex min-h-[17rem] flex-col rounded-lg border border-line bg-white p-4 shadow-sm">
      <div className="mb-3 flex gap-2">
        <SkeletonBlock className="h-6 w-20 rounded-full" />
        <SkeletonBlock className="h-6 w-14 rounded-full" />
      </div>
      <div className="space-y-2">
        <SkeletonBlock className="h-5 w-11/12" />
        <SkeletonBlock className="h-5 w-8/12" />
      </div>
      <div className="mt-4 space-y-2">
        <SkeletonBlock className="h-4 w-full" />
        <SkeletonBlock className="h-4 w-10/12" />
        <SkeletonBlock className="h-4 w-7/12" />
      </div>
      <div className="mt-4 flex gap-2">
        <SkeletonBlock className="h-6 w-16 rounded-full" />
        <SkeletonBlock className="h-6 w-20 rounded-full" />
      </div>
      <div className="grow" />
      <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
        <SkeletonBlock className="h-4 w-24" />
        <div className="flex gap-2">
          <SkeletonBlock className="h-8 w-14 rounded-md" />
          <SkeletonBlock className="size-8 rounded-md" />
          <SkeletonBlock className="size-8 rounded-md" />
        </div>
      </div>
    </div>
  );
}

function ArticleFeedSkeleton({ count }: { count: number }) {
  return (
    <section aria-busy="true" aria-live="polite" className="space-y-4">
      <span className="sr-only">자료를 불러오는 중입니다.</span>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SkeletonBlock className="h-5 w-24" />
        <SkeletonBlock className="h-5 w-20" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: count }).map((_, index) => (
          <ArticleCardSkeleton key={index} />
        ))}
      </div>
    </section>
  );
}

export function HomeFeedPanel({
  initialResult,
  initialRange,
  initialParamsString,
  sources,
  tags,
  jurisdictionArticleCounts,
  pageSize = 9,
}: HomeFeedPanelProps) {
  const [view, setView] = useState({
    articles: initialResult,
    range: initialRange,
    paramsString: initialParamsString,
    jurisdictionArticleCounts,
  });
  const [selectedRange, setSelectedRange] = useState(initialRange);
  const [isLoadingRange, setIsLoadingRange] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const payloadCacheRef = useRef(new Map<string, HomeRangePayload>());
  const pendingPayloadRef = useRef(new Map<string, Promise<HomeRangePayload>>());
  const requestIdRef = useRef(0);

  useEffect(() => {
    const initialPayload = { articles: initialResult, jurisdictionArticleCounts };
    payloadCacheRef.current.set(initialParamsString, initialPayload);
    setView({
      articles: initialResult,
      range: initialRange,
      paramsString: initialParamsString,
      jurisdictionArticleCounts,
    });
    setSelectedRange(initialRange);
    setIsLoadingRange(false);
    setErrorMessage(null);
  }, [initialParamsString, initialRange, initialResult, jurisdictionArticleCounts]);

  const fetchPayload = useCallback(
    async (paramsString: string) => {
      const cached = payloadCacheRef.current.get(paramsString);
      if (cached) return cached;

      const pending = pendingPayloadRef.current.get(paramsString);
      if (pending) return pending;

      const requestParams = new URLSearchParams(paramsString);
      requestParams.set("page", "1");
      requestParams.set("pageSize", String(pageSize));
      requestParams.set("count", "exact");

      const promise = fetch(`/api/home/range?${requestParams.toString()}`, {
        headers: { accept: "application/json" },
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return (await response.json()) as HomeRangePayload;
        })
        .then((payload) => {
          payloadCacheRef.current.set(paramsString, payload);
          return payload;
        })
        .finally(() => {
          pendingPayloadRef.current.delete(paramsString);
        });

      pendingPayloadRef.current.set(paramsString, promise);
      return promise;
    },
    [pageSize],
  );

  const changeRange = useCallback(
    async (range: TimeRange, href?: string, options: { updateUrl?: boolean; paramsString?: string } = {}) => {
      const targetParamsString = options.paramsString ?? paramsStringForRange(view.paramsString, range);
      if (targetParamsString === view.paramsString && range === view.range) {
        setSelectedRange(range);
        setIsLoadingRange(false);
        setErrorMessage(null);
        return;
      }

      const targetHref = href ?? hrefForParams(targetParamsString);
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setSelectedRange(range);
      setIsLoadingRange(true);
      setErrorMessage(null);

      if (options.updateUrl !== false && typeof window !== "undefined") {
        window.history.pushState(null, "", targetHref);
      }

      try {
        const payload = await fetchPayload(targetParamsString);
        if (requestId !== requestIdRef.current) return;

        setView({
          articles: payload.articles,
          range,
          paramsString: targetParamsString,
          jurisdictionArticleCounts: payload.jurisdictionArticleCounts,
        });
        setSelectedRange(range);
        setErrorMessage(null);
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        setErrorMessage(error instanceof Error ? error.message : "불러오기 실패");
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoadingRange(false);
        }
      }
    },
    [fetchPayload, view.paramsString, view.range],
  );

  const prefetchRange = useCallback(
    (range: TimeRange) => {
      if (range === selectedRange) return;
      const targetParamsString = paramsStringForRange(view.paramsString, range);
      void fetchPayload(targetParamsString).catch(() => null);
    },
    [fetchPayload, selectedRange, view.paramsString],
  );

  useEffect(() => {
    function handlePopState() {
      const paramsString = currentHomeParamsString();
      const range = normalizeRange(new URLSearchParams(paramsString).get("range"));
      void changeRange(range, hrefForParams(paramsString), { updateUrl: false, paramsString });
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [changeRange]);

  const activeParamsString = paramsStringForRange(view.paramsString, selectedRange);

  return (
    <>
      <div className="mb-6">
        <FilterBar
          activeRange={selectedRange}
          sources={sources}
          tags={tags}
          paramsString={activeParamsString}
          jurisdictionArticleCounts={view.jurisdictionArticleCounts}
          onRangeChange={changeRange}
          onRangePrefetch={prefetchRange}
        />
      </div>

      {errorMessage ? (
        <SurfaceCard className="mb-4 flex flex-wrap items-center justify-between gap-3 border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <span>필터 결과를 불러오지 못했습니다. {errorMessage}</span>
          <button
            type="button"
            onClick={() => void changeRange(selectedRange, hrefForParams(activeParamsString), { paramsString: activeParamsString })}
            className="focus-ring rounded-lg border border-red-200 bg-white px-3 py-2 font-semibold text-red-900"
          >
            다시 시도
          </button>
        </SurfaceCard>
      ) : null}

      {isLoadingRange ? (
        <ArticleFeedSkeleton count={pageSize} />
      ) : (
        <InfiniteArticleFeed key={view.paramsString} initialResult={view.articles} queryString={view.paramsString} pageSize={pageSize} />
      )}
    </>
  );
}
