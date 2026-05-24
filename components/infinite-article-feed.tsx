"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { ArticleGrid } from "@/components/article-grid";
import type { ArticleListItem, ArticleListResult, PageInfo } from "@/lib/db/types";

const FEED_PENDING_KEY = "worldcons:list-scroll:pending-feed";
const FEED_TTL_MS = 30 * 60 * 1000;

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

function currentReturnPath() {
  if (typeof window === "undefined") return "";
  return `${window.location.pathname}${window.location.search}`;
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

export function InfiniteArticleFeed({
  initialResult,
  endpoint = "/api/articles",
  queryString = "",
  pageSize = 10,
}: InfiniteArticleFeedProps) {
  const feedKey = `${endpoint}?${queryString}`;
  const [articles, setArticles] = useState(initialResult.items);
  const [pageInfo, setPageInfo] = useState(() => pageInfoFor(initialResult.pageInfo, pageSize));
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isExhausted, setIsExhausted] = useState(initialResult.items.length >= initialResult.pageInfo.total);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const pendingRestoreRef = useRef<FeedSnapshot | null>(null);

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
      setIsExhausted(snapshot.isExhausted || snapshot.articles.length >= snapshotPageInfo.total);
      pendingRestoreRef.current = snapshot;
    } else {
      setArticles(initialResult.items);
      setPageInfo(pageInfoFor(initialResult.pageInfo, pageSize));
      setIsExhausted(initialResult.items.length >= initialResult.pageInfo.total);
      pendingRestoreRef.current = null;
    }
    setErrorMessage(null);
    loadingRef.current = false;
    setIsLoading(false);
  }, [feedKey, initialResult, pageSize]);

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

  const hasMore = !isExhausted && articles.length < pageInfo.total;
  const loadedCount = Math.min(articles.length, pageInfo.total);

  const nextUrl = useMemo(() => {
    const params = new URLSearchParams(queryString);
    params.set("page", String(pageInfo.page + 1));
    params.set("pageSize", String(pageSize));
    const suffix = params.toString();
    return suffix ? `${endpoint}?${suffix}` : endpoint;
  }, [endpoint, pageInfo.page, pageSize, queryString]);

  const loadNext = useCallback(async () => {
    if (!hasMore || loadingRef.current) return;

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
      setArticles((current) => mergeArticles(current, nextItems));
      setPageInfo(pageInfoFor(result.pageInfo, pageSize));
      if (nextItems.length < pageSize || articles.length + nextItems.length >= result.pageInfo.total) {
        setIsExhausted(true);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "불러오기 실패");
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
    }
  }, [articles.length, hasMore, nextUrl, pageSize]);

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
          void loadNext();
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
        <p className="text-sm font-semibold text-ink">총 {pageInfo.total.toLocaleString("ko-KR")}건</p>
        <p className="text-sm text-ink-muted">{loadedCount.toLocaleString("ko-KR")}건 표시</p>
      </div>
      <ArticleGrid articles={articles} onArticleNavigate={saveReturnState} restoreScroll={false} />
      <div ref={sentinelRef} className="flex min-h-16 items-center justify-center pt-2">
        {isLoading ? (
          <span className="inline-flex items-center gap-2 text-sm font-medium text-ink-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            더 불러오는 중
          </span>
        ) : null}
        {!isLoading && errorMessage ? (
          <button
            type="button"
            onClick={() => void loadNext()}
            className="focus-ring rounded-lg border border-line bg-white px-3 py-2 text-sm font-semibold text-ink-muted"
          >
            다시 불러오기
          </button>
        ) : null}
        {!isLoading && !errorMessage && !hasMore && articles.length > 0 ? (
          <span className="text-sm text-ink-subtle">마지막 항목입니다</span>
        ) : null}
      </div>
    </section>
  );
}
