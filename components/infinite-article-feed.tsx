"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ArticleGrid } from "@/components/article-grid";
import type { ArticleListItem, ArticleListResult, PageInfo } from "@/lib/db/types";

const FEED_PENDING_KEY = "worldcons:list-scroll:pending-feed";
const FEED_TTL_MS = 30 * 60 * 1000;
const AUTO_LOAD_SCROLL_DELTA_PX = 48;

interface InfiniteArticleFeedProps {
  initialResult: ArticleListResult;
  endpoint?: string;
  queryString?: string;
  pageSize?: number;
}

interface FeedSnapshot {
  feedKey: string;
  returnPath: string;
  articles: ArticleListItem[];
  pageInfo: PageInfo;
  isExhausted: boolean;
  clickedSlug: string;
  scrollY: number;
  targetTop: number;
  savedAt: number;
}

interface AppendAnchor {
  slug: string;
  top: number;
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

function slimArticleForSnapshot(article: ArticleListItem): ArticleListItem {
  return {
    ...article,
    summaryJson: null,
  };
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
      !Array.isArray(snapshot.articles) ||
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

function LoadMoreSkeletonGrid({ count }: { count: number }) {
  return (
    <div aria-busy="true" aria-live="polite" className="[overflow-anchor:none]">
      <span className="sr-only">더 많은 자료를 불러오는 중입니다.</span>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
}: InfiniteArticleFeedProps) {
  const feedKey = `${endpoint}?${queryString}`;
  const [articles, setArticles] = useState(initialResult.items);
  const [pageInfo, setPageInfo] = useState(() => pageInfoFor(initialResult.pageInfo, pageSize));
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isExhausted, setIsExhausted] = useState(!hasMorePages(initialResult.pageInfo, initialResult.items.length));
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const pendingRestoreRef = useRef<FeedSnapshot | null>(null);
  const lastLoadScrollYRef = useRef<number | null>(null);
  const appendAnchorRef = useRef<AppendAnchor | null>(null);

  useEffect(() => {
    const snapshot = readFeedSnapshot(feedKey);
    if (snapshot) {
      const snapshotPageInfo = {
        ...snapshot.pageInfo,
        pageSize,
        total: Math.max(snapshot.pageInfo.total, initialResult.pageInfo.total),
      };
      setArticles(snapshot.articles);
      setPageInfo(snapshotPageInfo);
      setIsExhausted(snapshot.isExhausted || !hasMorePages(snapshotPageInfo, snapshot.articles.length));
      pendingRestoreRef.current = snapshot;
    } else {
      setArticles(initialResult.items);
      setPageInfo(pageInfoFor(initialResult.pageInfo, pageSize));
      setIsExhausted(!hasMorePages(initialResult.pageInfo, initialResult.items.length));
      pendingRestoreRef.current = null;
    }
    setErrorMessage(null);
    loadingRef.current = false;
    lastLoadScrollYRef.current = null;
    appendAnchorRef.current = null;
    setIsLoading(false);
  }, [feedKey, initialResult, pageSize]);

  useLayoutEffect(() => {
    const anchor = appendAnchorRef.current;
    if (!anchor) return;

    appendAnchorRef.current = null;
    const anchoredElement = findArticleElement(anchor.slug);
    if (!anchoredElement) return;

    const delta = anchoredElement.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 1) {
      window.scrollBy({ top: delta, behavior: "auto" });
    }
  }, [articles.length]);

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

  const hasMore = !isExhausted && hasMorePages(pageInfo, articles.length);
  const loadedCount = pageInfo.totalIsExact === false ? articles.length : Math.min(articles.length, pageInfo.total);
  const totalPrefix = pageInfo.totalIsExact === false ? "약 " : "";

  const nextUrl = useMemo(() => {
    const params = new URLSearchParams(queryString);
    params.set("page", String(pageInfo.page + 1));
    params.set("pageSize", String(pageSize));
    const suffix = params.toString();
    return suffix ? `${endpoint}?${suffix}` : endpoint;
  }, [endpoint, pageInfo.page, pageSize, queryString]);

  const loadNext = useCallback(async (trigger: "auto" | "manual" = "manual") => {
    if (!hasMore || loadingRef.current) return;

    const scrollY = currentScrollY();
    if (trigger === "auto" && lastLoadScrollYRef.current !== null && scrollY <= lastLoadScrollYRef.current + AUTO_LOAD_SCROLL_DELTA_PX) {
      return;
    }

    const lastArticle = articles.at(-1);
    const lastArticleElement = lastArticle ? findArticleElement(lastArticle.slug) : null;
    appendAnchorRef.current = lastArticle && lastArticleElement ? { slug: lastArticle.slug, top: lastArticleElement.getBoundingClientRect().top } : null;

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
      if (nextItems.length === 0) {
        appendAnchorRef.current = null;
      }
      setArticles((current) => mergeArticles(current, nextItems));
      setPageInfo(pageInfoFor(result.pageInfo, pageSize));
      if (nextItems.length === 0 || !hasMorePages(result.pageInfo, articles.length + nextItems.length)) {
        setIsExhausted(true);
      }
    } catch (error) {
      appendAnchorRef.current = null;
      setErrorMessage(error instanceof Error ? error.message : "불러오기 실패");
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
    }
  }, [articles, hasMore, nextUrl, pageSize]);

  const saveReturnState = useCallback(
    (clickedSlug: string) => {
      if (typeof window === "undefined") return;

      const target = findArticleElement(clickedSlug);
      const snapshot: FeedSnapshot = {
        feedKey,
        returnPath: currentReturnPath(),
        articles: articles.map(slimArticleForSnapshot),
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
        try {
          window.sessionStorage.setItem(
            storageKey,
            JSON.stringify({
              ...snapshot,
              articles: [],
            }),
          );
          window.sessionStorage.setItem(FEED_PENDING_KEY, storageKey);
        } catch {
          // Ignore private-mode or quota failures; browser default restoration remains available.
        }
      }
    },
    [articles, feedKey, isExhausted, pageInfo],
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink">
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
            className="focus-ring rounded-lg border border-line bg-white px-3 py-2 text-sm font-semibold text-ink-muted"
          >
            다시 불러오기
          </button>
        ) : null}
        {!isLoading && !errorMessage && hasMore ? (
          <button
            type="button"
            onClick={() => void loadNext("manual")}
            className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-white px-4 text-sm font-semibold text-ink-muted transition hover:border-line-strong hover:text-ink"
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
