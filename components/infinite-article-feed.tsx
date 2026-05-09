"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { ArticleGrid } from "@/components/article-grid";
import type { ArticleListItem, ArticleListResult, PageInfo } from "@/lib/db/types";

interface InfiniteArticleFeedProps {
  initialResult: ArticleListResult;
  endpoint?: string;
  queryString?: string;
  pageSize?: number;
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

  useEffect(() => {
    setArticles(initialResult.items);
    setPageInfo(pageInfoFor(initialResult.pageInfo, pageSize));
    setErrorMessage(null);
    setIsExhausted(initialResult.items.length >= initialResult.pageInfo.total);
    loadingRef.current = false;
    setIsLoading(false);
  }, [feedKey, initialResult, pageSize]);

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
        <p className="text-sm text-ink/62">총 {pageInfo.total}건</p>
        <p className="text-sm text-ink/50">{loadedCount}건 표시</p>
      </div>
      <ArticleGrid articles={articles} />
      <div ref={sentinelRef} className="flex min-h-16 items-center justify-center pt-2">
        {isLoading ? (
          <span className="inline-flex items-center gap-2 text-sm font-medium text-ink/58">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            더 불러오는 중
          </span>
        ) : null}
        {!isLoading && errorMessage ? (
          <button
            type="button"
            onClick={() => void loadNext()}
            className="focus-ring rounded-md border border-rule bg-white px-3 py-2 text-sm font-semibold text-ink/72"
          >
            다시 불러오기
          </button>
        ) : null}
        {!isLoading && !errorMessage && !hasMore && articles.length > 0 ? (
          <span className="text-sm text-ink/45">마지막 항목입니다</span>
        ) : null}
      </div>
    </section>
  );
}
