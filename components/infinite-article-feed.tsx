"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ArticleGrid } from "@/components/article-grid";
import { ARTICLE_VIEWED_STORAGE_PREFIX } from "@/components/analytics-event-client";
import type { ArticleListItem, ArticleListResult, PageInfo } from "@/lib/db/types";

const FEED_PENDING_KEY = "worldcons:list-scroll:pending-feed";
const FEED_TTL_MS = 30 * 60 * 1000;
const AUTO_LOAD_SCROLL_DELTA_PX = 48;

interface InfiniteArticleFeedProps {
  initialResult: ArticleListResult;
  endpoint?: string;
  queryString?: string;
  pageSize?: number;
  leadingItemCount?: number;
}

interface FeedSnapshot {
  feedKey: string;
  returnPath: string;
  pageInfo: PageInfo;
  isExhausted: boolean;
  clickedSlug: string;
  scrollY: number;
  targetTop: number;
  savedAt: number;
}

function mergeArticles(current: ArticleListItem[], incoming: ArticleListItem[]) {
  const seen = new Set(current.map((article) => article.id ?? article.slug));
  const merged = [...current];

  incoming.forEach((article) => {
    const key = article.id ?? article.slug;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(article);
  });

  return merged;
}

function pageInfoFor(pageInfo: PageInfo, pageSize: number): PageInfo {
  return {
    ...pageInfo,
    pageSize,
  };
}

function hasMorePages(pageInfo: PageInfo, itemCount: number) {
  if (typeof pageInfo.hasMore === "boolean") {
    return pageInfo.hasMore;
  }
  return itemCount < pageInfo.total;
}

function currentReturnPath() {
  if (typeof window === "undefined") return "";
  return `${window.location.pathname}${window.location.search}`;
}

function currentScrollY() {
  if (typeof window === "undefined") return 0;
  return window.scrollY;
}

function storageKeyFor(feedKey: string) {
  return `worldcons:list-scroll:feed:${feedKey}`;
}

function findArticleElement(slug: string) {
  if (typeof document === "undefined") return null;
  return [...document.querySelectorAll<HTMLElement>("[data-article-slug]")].find((element) => element.dataset.articleSlug === slug) ?? null;
}

function readFeedSnapshot(feedKey: string) {
  if (typeof window === "undefined") return null;

  const storageKey = storageKeyFor(feedKey);
  if (window.sessionStorage.getItem(FEED_PENDING_KEY) !== storageKey) {
    return null;
  }

  const raw = window.sessionStorage.getItem(storageKey);
  if (!raw) return null;

  try {
    const snapshot = JSON.parse(raw) as Partial<FeedSnapshot>;
    if (
      snapshot.feedKey !== feedKey ||
      snapshot.returnPath !== currentReturnPath() ||
      !snapshot.pageInfo ||
      typeof snapshot.pageInfo.page !== "number" ||
      typeof snapshot.pageInfo.pageSize !== "number" ||
      typeof snapshot.pageInfo.total !== "number" ||
      (snapshot.pageInfo.hasMore !== undefined && typeof snapshot.pageInfo.hasMore !== "boolean") ||
      (snapshot.pageInfo.totalIsExact !== undefined && typeof snapshot.pageInfo.totalIsExact !== "boolean") ||
      typeof snapshot.clickedSlug !== "string" ||
      typeof snapshot.scrollY !== "number" ||
      typeof snapshot.targetTop !== "number" ||
      typeof snapshot.savedAt !== "number" ||
      Date.now() - snapshot.savedAt > FEED_TTL_MS
    ) {
      return null;
    }

    return snapshot as FeedSnapshot;
  } catch {
    return null;
  }
}

function articleViewedAfterSnapshot(slug: string, savedAt: number) {
  if (typeof window === "undefined") return false;

  const raw = window.sessionStorage.getItem(`${ARTICLE_VIEWED_STORAGE_PREFIX}${slug}`);
  const viewedAt = raw ? Number(raw) : 0;
  return Number.isFinite(viewedAt) && viewedAt >= savedAt;
}

function articlesWithRestoredView(articles: ArticleListItem[], snapshot: FeedSnapshot) {
  if (!articleViewedAfterSnapshot(snapshot.clickedSlug, snapshot.savedAt)) {
    return articles;
  }

  return articles.map((article) => {
    if (article.slug !== snapshot.clickedSlug) return article;
    return {
      ...article,
      viewCount: Math.max(0, Math.floor(article.viewCount ?? 0)) + 1,
    };
  });
}

function restoreFeedScroll(snapshot: FeedSnapshot) {
  const target = findArticleElement(snapshot.clickedSlug);
  if (target) {
    const targetY = target.getBoundingClientRect().top + window.scrollY - snapshot.targetTop;
    window.scrollTo({ top: Math.max(0, targetY), behavior: "auto" });
    return;
  }

  window.scrollTo({ top: Math.max(0, snapshot.scrollY), behavior: "auto" });
}

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-surface-muted ${className}`} />;
}

function ArticleCardSkeleton() {
  return (
    <div className="border-b border-archive-line px-1 py-5 last:border-b-0 sm:grid sm:grid-cols-[132px_minmax(0,1fr)_72px] sm:gap-5 sm:px-3">
      <div className="mb-3 space-y-2 sm:mb-0">
        <SkeletonBlock className="h-4 w-24 rounded-sm" />
        <SkeletonBlock className="h-4 w-20 rounded-sm" />
      </div>
      <div>
        <SkeletonBlock className="h-5 w-11/12 rounded-sm" />
        <SkeletonBlock className="mt-2 h-4 w-full rounded-sm" />
        <SkeletonBlock className="mt-2 h-4 w-9/12 rounded-sm" />
        <div className="mt-3 flex gap-2">
          <SkeletonBlock className="h-6 w-16 rounded-sm" />
          <SkeletonBlock className="h-6 w-20 rounded-sm" />
        </div>
      </div>
      <div className="mt-4 sm:mt-0 sm:flex sm:justify-end">
        <SkeletonBlock className="h-4 w-12 rounded-sm" />
      </div>
    </div>
  );
}

function LoadMoreSkeletonGrid({ count }: { count: number }) {
  return (
    <div aria-busy="true" aria-live="polite" className="[overflow-anchor:none]">
      <span className="sr-only">더 많은 자료를 불러오는 중입니다.</span>
      <div className="border-y border-archive-line-strong bg-white">
        {Array.from({ length: count }).map((_, index) => (
          <ArticleCardSkeleton key={index} />
        ))}
      </div>
    </div>
  );
}

export function InfiniteArticleFeed({
  initialResult,
  endpoint = "/api/articles",
  queryString = "",
  pageSize = 9,
  leadingItemCount = 0,
}: InfiniteArticleFeedProps) {
  const feedKey = `${endpoint}?${queryString}`;
  const [articles, setArticles] = useState(initialResult.items);
  const [pageInfo, setPageInfo] = useState(() => pageInfoFor(initialResult.pageInfo, pageSize));
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isExhausted, setIsExhausted] = useState(!hasMorePages(initialResult.pageInfo, initialResult.items.length + leadingItemCount));
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const pendingRestoreRef = useRef<FeedSnapshot | null>(null);
  const lastLoadScrollYRef = useRef<number | null>(null);

  const pageUrl = useCallback(
    (page: number) => {
      const params = new URLSearchParams(queryString);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      if (!params.has("count")) {
        params.set("count", "none");
      }
      const suffix = params.toString();
      return suffix ? `${endpoint}?${suffix}` : endpoint;
    },
    [endpoint, pageSize, queryString],
  );

  const fetchPage = useCallback(
    async (page: number) => {
      const response = await fetch(pageUrl(page), {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as ArticleListResult;
    },
    [pageUrl],
  );

  useEffect(() => {
    const snapshot = readFeedSnapshot(feedKey);
    if (snapshot) {
      const restoreSnapshotData = snapshot;
      let cancelled = false;
      const initialArticles = articlesWithRestoredView(initialResult.items, restoreSnapshotData);
      setArticles(initialArticles);
      setPageInfo(pageInfoFor(initialResult.pageInfo, pageSize));
      setIsExhausted(!hasMorePages(initialResult.pageInfo, initialArticles.length + leadingItemCount));
      pendingRestoreRef.current = null;
      setErrorMessage(null);
      loadingRef.current = false;
      lastLoadScrollYRef.current = restoreSnapshotData.scrollY;
      setIsLoading(false);

      async function restoreLoadedPages() {
        if (restoreSnapshotData.pageInfo.page <= initialResult.pageInfo.page) {
          pendingRestoreRef.current = restoreSnapshotData;
          setArticles((current) => articlesWithRestoredView(current, restoreSnapshotData));
          return;
        }

        loadingRef.current = true;
        setIsLoading(true);
        try {
          let merged = initialArticles;
          let restoredPageInfo = pageInfoFor(initialResult.pageInfo, pageSize);
          for (let page = initialResult.pageInfo.page + 1; page <= restoreSnapshotData.pageInfo.page; page += 1) {
            const result = await fetchPage(page);
            if (cancelled) return;
            merged = mergeArticles(merged, result.items ?? []);
            restoredPageInfo = pageInfoFor(result.pageInfo, pageSize);
          }

          if (cancelled) return;
          const viewedArticles = articlesWithRestoredView(merged, restoreSnapshotData);
          const snapshotPageInfo = {
            ...restoreSnapshotData.pageInfo,
            pageSize,
            total: Math.max(
              restoreSnapshotData.pageInfo.total,
              restoredPageInfo.total,
              initialResult.pageInfo.total,
              viewedArticles.length + leadingItemCount,
            ),
          };
          setArticles(viewedArticles);
          setPageInfo(snapshotPageInfo);
          setIsExhausted(restoreSnapshotData.isExhausted || !hasMorePages(snapshotPageInfo, viewedArticles.length + leadingItemCount));
          pendingRestoreRef.current = restoreSnapshotData;
        } catch {
          if (!cancelled) {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => restoreFeedScroll(restoreSnapshotData));
            });
          }
        } finally {
          if (!cancelled) {
            loadingRef.current = false;
            setIsLoading(false);
          }
        }
      }

      void restoreLoadedPages();
      return () => {
        cancelled = true;
      };
    } else {
      setArticles(initialResult.items);
      setPageInfo(pageInfoFor(initialResult.pageInfo, pageSize));
      setIsExhausted(!hasMorePages(initialResult.pageInfo, initialResult.items.length + leadingItemCount));
      pendingRestoreRef.current = null;
    }
    setErrorMessage(null);
    loadingRef.current = false;
    lastLoadScrollYRef.current = null;
    setIsLoading(false);
  }, [feedKey, fetchPage, initialResult, leadingItemCount, pageSize]);

  useEffect(() => {
    const snapshot = pendingRestoreRef.current;
    if (!snapshot) return;

    pendingRestoreRef.current = null;
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(FEED_PENDING_KEY);
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => restoreFeedScroll(snapshot));
    });
  }, [articles, feedKey]);

  const hasMore = !isExhausted && hasMorePages(pageInfo, articles.length + leadingItemCount);
  const loadedItems = articles.length + leadingItemCount;
  const loadedCount = pageInfo.totalIsExact === false ? loadedItems : Math.min(loadedItems, pageInfo.total);
  const totalPrefix = pageInfo.totalIsExact === false ? "약 " : "";

  const nextUrl = useMemo(() => {
    return pageUrl(pageInfo.page + 1);
  }, [pageInfo.page, pageUrl]);

  const loadNext = useCallback(async (trigger: "auto" | "manual" = "manual") => {
    if (!hasMore || loadingRef.current) return;

    const scrollY = currentScrollY();
    if (trigger === "auto" && lastLoadScrollYRef.current !== null && scrollY <= lastLoadScrollYRef.current + AUTO_LOAD_SCROLL_DELTA_PX) {
      return;
    }

    lastLoadScrollYRef.current = scrollY;
    loadingRef.current = true;
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const response = await fetch(nextUrl, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = (await response.json()) as ArticleListResult;
      const nextItems = result.items ?? [];
      const nextLoadedCount = articles.length + nextItems.length + leadingItemCount;
      const resultPageInfo = pageInfoFor(result.pageInfo, pageSize);
      setArticles((current) => mergeArticles(current, nextItems));
      setPageInfo((current) => {
        const preserveExactTotal = current.totalIsExact === true && resultPageInfo.totalIsExact !== true;
        return {
          ...resultPageInfo,
          total: preserveExactTotal ? Math.max(current.total, nextLoadedCount) : Math.max(resultPageInfo.total, nextLoadedCount),
          totalIsExact: preserveExactTotal ? true : resultPageInfo.totalIsExact,
        };
      });
      if (nextItems.length === 0 || !hasMorePages(resultPageInfo, nextLoadedCount)) {
        setIsExhausted(true);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "불러오기 실패");
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
    }
  }, [articles, hasMore, leadingItemCount, nextUrl, pageSize]);

  const saveReturnState = useCallback(
    (clickedSlug: string) => {
      if (typeof window === "undefined") return;

      const target = findArticleElement(clickedSlug);
      const snapshot: FeedSnapshot = {
        feedKey,
        returnPath: currentReturnPath(),
        pageInfo,
        isExhausted,
        clickedSlug,
        scrollY: window.scrollY,
        targetTop: target?.getBoundingClientRect().top ?? 120,
        savedAt: Date.now(),
      };
      const storageKey = storageKeyFor(feedKey);

      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(snapshot));
        window.sessionStorage.setItem(FEED_PENDING_KEY, storageKey);
      } catch {
        // Ignore private-mode or quota failures; browser default restoration remains available.
      }
    },
    [feedKey, isExhausted, pageInfo],
  );

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadNext("auto");
        }
      },
      { rootMargin: "520px 0px 520px 0px", threshold: 0.01 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadNext]);

  return (
    <section className="space-y-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-archive-line-strong pb-3">
        <p className="text-sm font-semibold text-archive-heading">
          총 {totalPrefix}
          {pageInfo.total.toLocaleString("ko-KR")}건
        </p>
        <p className="text-sm text-ink-muted">{loadedCount.toLocaleString("ko-KR")}건 표시</p>
      </div>
      <ArticleGrid articles={articles} onArticleNavigate={saveReturnState} restoreScroll={false} />
      {isLoading ? <LoadMoreSkeletonGrid count={pageSize} /> : null}
      <div ref={sentinelRef} className="flex min-h-16 items-center justify-center pt-2 [overflow-anchor:none]">
        {!isLoading && errorMessage ? (
          <button
            type="button"
            onClick={() => void loadNext("manual")}
            className="focus-ring rounded-sm border border-archive-line-strong bg-white px-3 py-2 text-sm font-semibold text-archive-text hover:bg-archive-surface-soft"
          >
            다시 불러오기
          </button>
        ) : null}
        {!isLoading && !errorMessage && hasMore ? (
          <button
            type="button"
            onClick={() => void loadNext("manual")}
            className="focus-ring inline-flex min-h-10 items-center gap-2 rounded-sm border border-archive-line-strong bg-white px-4 text-sm font-semibold text-archive-text transition-colors hover:bg-archive-surface-soft hover:text-archive-accent"
          >
            더 보기
            <ChevronDown className="size-4" aria-hidden="true" />
          </button>
        ) : null}
        {!isLoading && !errorMessage && !hasMore && articles.length > 0 ? (
          <span className="text-sm text-ink-subtle">마지막 항목입니다</span>
        ) : null}
      </div>
    </section>
  );
}
